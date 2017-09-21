/**
* Copyright 2012-2017, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/


'use strict';

/* global PlotlyGeoAssets:false */

var d3 = require('d3');

var Lib = require('../../lib');
var Color = require('../../components/color');
var Drawing = require('../../components/drawing');
var Fx = require('../../components/fx');
var Plots = require('../plots');
var Axes = require('../cartesian/axes');
var dragElement = require('../../components/dragelement');
var prepSelect = require('../cartesian/select');

var createGeoZoom = require('./zoom');
var constants = require('./constants');

var topojsonUtils = require('../../lib/topojson_utils');
var topojsonFeature = require('topojson-client').feature;

require('./projections')(d3);

function Geo(opts) {
    this.id = opts.id;
    this.graphDiv = opts.graphDiv;
    this.container = opts.container;
    this.topojsonURL = opts.topojsonURL;
    this.isStatic = opts.staticPlot;

    var geoLayout = this.graphDiv._fullLayout[this.id];
    var center = geoLayout.center || {};
    var projLayout = geoLayout.projection;
    var rotation = projLayout.rotation || {};

    this.viewInitial = {
        'center.lon': center.lon,
        'center.lat': center.lat,
        'projection.scale': projLayout.scale,
        'projection.rotation.lon': rotation.lon,
        'projection.rotation.lat': rotation.lat
    };

    this.topojsonName = null;
    this.topojson = null;

    this.projection = null;
    this.fitScale = null;
    this.bounds = null;
    this.midPt = null;

    this.hasChoropleth = false;
    this.traceHash = {};

    this.layers = {};
    this.basePaths = {};
    this.dataPaths = {};
    this.dataPoints = {};

    this.clipDef = null;
    this.clipRect = null;
    this.bgRect = null;

    this.makeFramework();
}

var proto = Geo.prototype;

module.exports = function createGeo(opts) {
    return new Geo(opts);
};

proto.plot = function(geoCalcData, fullLayout, promises) {
    var _this = this;
    var geoLayout = fullLayout[this.id];
    var topojsonNameNew = topojsonUtils.getTopojsonName(geoLayout);

    if(_this.topojson === null || topojsonNameNew !== _this.topojsonName) {
        _this.topojsonName = topojsonNameNew;

        if(PlotlyGeoAssets.topojson[_this.topojsonName] === undefined) {
            promises.push(_this.fetchTopojson().then(function(topojson) {
                PlotlyGeoAssets.topojson[_this.topojsonName] = topojson;
                _this.topojson = topojson;
                _this.update(geoCalcData, fullLayout);
            }));
        } else {
            _this.topojson = PlotlyGeoAssets.topojson[_this.topojsonName];
            _this.update(geoCalcData, fullLayout);
        }
    } else {
        _this.update(geoCalcData, fullLayout);
    }
};

proto.fetchTopojson = function() {
    var topojsonPath = topojsonUtils.getTopojsonPath(
        this.topojsonURL,
        this.topojsonName
    );
    return new Promise(function(resolve, reject) {
        d3.json(topojsonPath, function(err, topojson) {
            if(err) {
                if(err.status === 404) {
                    return reject(new Error([
                        'plotly.js could not find topojson file at',
                        topojsonPath, '.',
                        'Make sure the *topojsonURL* plot config option',
                        'is set properly.'
                    ].join(' ')));
                } else {
                    return reject(new Error([
                        'unexpected error while fetching topojson file at',
                        topojsonPath
                    ].join(' ')));
                }
            }
            resolve(topojson);
        });
    });
};

proto.update = function(geoCalcData, fullLayout) {
    var geoLayout = fullLayout[this.id];

    // important: maps with choropleth traces have a different layer order
    this.hasChoropleth = false;
    for(var i = 0; i < geoCalcData.length; i++) {
        if(geoCalcData[i][0].trace.type === 'choropleth') {
            this.hasChoropleth = true;
            break;
        }
    }

    this.updateProjection(fullLayout, geoLayout);
    this.updateBaseLayers(fullLayout, geoLayout);
    this.updateDims(fullLayout, geoLayout);

    Plots.generalUpdatePerTraceModule(this, geoCalcData, geoLayout);

    var scatterLayer = this.layers.frontplot.select('.scatterlayer');
    this.dataPoints.point = scatterLayer.selectAll('.point');
    this.dataPoints.text = scatterLayer.selectAll('text');
    this.dataPaths.line = scatterLayer.selectAll('.js-line');

    var choroplethLayer = this.layers.backplot.select('.choroplethlayer');
    this.dataPaths.choropleth = choroplethLayer.selectAll('path');

    this.updateFx(fullLayout, geoLayout);
    this.render();
};

proto.updateProjection = function(fullLayout, geoLayout) {
    var gs = fullLayout._size;
    var domain = geoLayout.domain;
    var projLayout = geoLayout.projection;
    var rotation = projLayout.rotation || {};
    var center = geoLayout.center || {};

    var projection = this.projection = getProjection(geoLayout);

    // set 'pre-fit' projection
    projection
        .center([center.lon - rotation.lon, center.lat - rotation.lat])
        .rotate([-rotation.lon, -rotation.lat, rotation.roll])
        .parallels(projLayout.parallels);

    // setup subplot extent [[x0,y0], [x1,y1]]
    var extent = [[
        gs.l + gs.w * domain.x[0],
        gs.t + gs.h * (1 - domain.y[1])
    ], [
        gs.l + gs.w * domain.x[1],
        gs.t + gs.h * (1 - domain.y[0])
    ]];

    var rangeBox = makeRangeBox(geoLayout.lonaxis.range, geoLayout.lataxis.range);

    // fit projection 'scale' and 'translate' to set lon/lat ranges
    projection.fitExtent(extent, rangeBox);

    var b = this.bounds = projection.getBounds(rangeBox);
    var s = this.fitScale = projection.scale();
    var t = projection.translate();

    if(
        !isFinite(b[0][0]) || !isFinite(b[0][1]) ||
        !isFinite(b[1][0]) || !isFinite(b[1][1]) ||
        isNaN(t[0]) || isNaN(t[0])
    ) {
        Lib.warn('Invalid geo settings');

        // TODO fallback to default ???
    }

    // px coordinates of view mid-point,
    // useful to update `geo.center` after interactions
    var midPt = this.midPt = [
        b[0][0] + (b[1][0] - b[0][0]) / 2,
        b[0][1] + (b[1][1] - b[0][1]) / 2
    ];

    // adjust projection to user setting
    projection
        .scale(projLayout.scale * s)
        .translate([t[0] + (midPt[0] - t[0]), t[1] + (midPt[1] - t[1])])
        .clipExtent(b);

    // the 'albers usa' projection does not expose a 'center' method
    // so here's this hack to make it respond to 'geoLayout.center'
    if(geoLayout._isAlbersUsa) {
        var centerPx = projection([center.lon, center.lat]);
        var tt = projection.translate();

        projection.translate([
            tt[0] - (centerPx[0] - tt[0]),
            tt[1] - (centerPx[1] - tt[1])
        ]);
    }
};

proto.updateBaseLayers = function(fullLayout, geoLayout) {
    var _this = this;
    var topojson = _this.topojson;
    var layers = _this.layers;
    var basePaths = _this.basePaths;

    function isAxisLayer(d) {
        return (d === 'lonaxis' || d === 'lataxis');
    }

    function isTopoLayer(d) {
        return (
            constants.fillLayers.indexOf(d) !== -1 ||
            constants.lineLayers.indexOf(d) !== -1
        );
    }

    var allLayers = this.hasChoropleth ?
        constants.layersForChoropleth :
        constants.layers;

    var layerData = allLayers.filter(function(d) {
        return isTopoLayer(d) ? geoLayout['show' + d] :
            isAxisLayer(d) ? geoLayout[d].showgrid :
            true;
    });

    var join = _this.framework.selectAll('.layer')
        .data(layerData, String);

    join.exit().each(function(d) {
        delete layers[d];
        delete basePaths[d];
        d3.select(this).remove();
    });

    join.enter().append('g')
        .attr('class', function(d) { return 'layer ' + d; })
        .each(function(d) {
            var layer = layers[d] = d3.select(this);

            if(d === 'bg') {
                _this.bgRect = layer.append('rect').style('pointer-events', 'all');
            } else if(isAxisLayer(d)) {
                basePaths[d] = layer.append('path');
            } else if(d === 'backplot') {
                layer.append('g').classed('choroplethlayer', true);
            } else if(d === 'frontplot') {
                layer.append('g').classed('scatterlayer', true);
            } else if(isTopoLayer(d)) {
                basePaths[d] = layer.append('path');
            }
        });

    join.order();

    join.each(function(d) {
        var path = basePaths[d];
        var adj = constants.layerNameToAdjective[d];

        if(d === 'frame') {
            path.datum(constants.sphereSVG);
        } else if(isTopoLayer(d)) {
            path.datum(topojsonFeature(topojson, topojson.objects[d]));
        } else if(isAxisLayer(d)) {
            path.datum(makeGraticule(d, geoLayout))
                .attr('fill', 'none')
                .call(Color.stroke, geoLayout[d].gridcolor)
                .call(Drawing.dashLine, '', geoLayout[d].gridwidth);
        }

        if(constants.fillLayers.indexOf(d) !== -1) {
            path.attr('stroke', 'none')
                .call(Color.fill, geoLayout[adj + 'color']);
        } else if(constants.lineLayers.indexOf(d) !== -1) {
            path.attr('fill', 'none')
                .call(Color.stroke, geoLayout[adj + 'color'])
                .call(Drawing.dashLine, '', geoLayout[adj + 'width']);
        }
    });
};

proto.updateDims = function(fullLayout, geoLayout) {
    var b = this.bounds;
    var hFrameWidth = (geoLayout.framewidth || 0) / 2;

    var l = b[0][0] - hFrameWidth;
    var t = b[0][1] - hFrameWidth;
    var w = b[1][0] - l + hFrameWidth;
    var h = b[1][1] - t + hFrameWidth;

    Drawing.setRect(this.clipRect, l, t, w, h);

    this.bgRect
        .call(Drawing.setRect, l, t, w, h)
        .call(Color.fill, geoLayout.bgcolor);

    this.xaxis._offset = l;
    this.xaxis._length = w;

    this.yaxis._offset = t;
    this.yaxis._length = h;
};

proto.updateFx = function(fullLayout, geoLayout) {
    var _this = this;
    var framework = _this.framework;
    var gd = _this.graphDiv;
    var dragMode = fullLayout.dragmode;

    if(_this.isStatic) return;

    function zoomReset() {
        var view = Lib.expandObjectPaths(Lib.extendFlat({}, _this.viewInitial));
        view.projection.type = geoLayout.projection.type;
        view.projection.parallels = geoLayout.projection.parallels;
        view.domain = geoLayout.domain;
        view.lonaxis = geoLayout.lonaxis;
        view.lataxis = geoLayout.lataxis;

        _this.updateProjection(fullLayout, view);
        _this.updateFx(fullLayout, geoLayout);
        _this.render();

        // TODO call sync !!!
        //
        //
    }

    function invert(lonlat) {
        return _this.projection.invert([
            lonlat[0] + _this.xaxis._offset,
            lonlat[1] + _this.yaxis._offset
        ]);
    }

    if(dragMode === 'pan') {
        _this.bgRect.node().onmousedown = null;
        framework.call(createGeoZoom(_this, geoLayout));
        framework.on('dblclick.zoom', zoomReset);
    }
    else if(dragMode === 'select' || dragMode === 'lasso') {
        framework.on('.zoom', null);

        var fillRangeItems;

        if(dragMode === 'select') {
            fillRangeItems = function(eventData, poly) {
                var ranges = eventData.range = {};
                ranges[_this.id] = [
                    invert([poly.xmin, poly.ymin]),
                    invert([poly.xmax, poly.ymax])
                ];
            };
        } else if(dragMode === 'lasso') {
            fillRangeItems = function(eventData, poly, pts) {
                var dataPts = eventData.lassoPoints = {};
                dataPts[_this.id] = pts.filtered.map(invert);
            };
        }

        var dragOptions = {
            element: _this.bgRect.node(),
            gd: gd,
            plotinfo: {
                xaxis: _this.xaxis,
                yaxis: _this.yaxis,
                fillRangeItems: fillRangeItems
            },
            xaxes: [_this.xaxis],
            yaxes: [_this.yaxis],
            subplot: _this.id
        };

        dragOptions.prepFn = function(e, startX, startY) {
            prepSelect(e, startX, startY, dragOptions, dragMode);
        };

        dragOptions.doneFn = function(dragged, numClicks) {
            if(numClicks === 2) {
                fullLayout._zoomlayer.selectAll('.select-outline').remove();
            }
        };

        dragElement.init(dragOptions);
    }

    framework.on('mousemove', function() {
        var lonlat = _this.projection.invert(d3.mouse(this));

        if(!lonlat || isNaN(lonlat[0]) || isNaN(lonlat[1])) return;

        _this.xaxis.p2c = function() { return lonlat[0]; };
        _this.yaxis.p2c = function() { return lonlat[1]; };

        Fx.hover(gd, d3.event, _this.id);
    });

    framework.on('mouseout', function() {
        Fx.loneUnhover(fullLayout._toppaper);
    });

    framework.on('click', function() {
        Fx.click(gd, d3.event);
    });
};

proto.makeFramework = function() {
    var _this = this;
    var fullLayout = _this.graphDiv._fullLayout;
    var clipId = 'clip' + fullLayout._uid + _this.id;

    var defGroup = fullLayout._defs.selectAll('g.clips')
        .data([0]);
    defGroup.enter().append('g')
        .classed('clips', true);

    _this.clipDef = defGroup.append('clipPath')
        .attr('id', clipId);

    _this.clipRect = this.clipDef.append('rect');

    _this.framework = d3.select(_this.container).append('g')
        .attr('class', 'geo ' + _this.id)
        .call(Drawing.setClipUrl, clipId);

    _this.xaxis = {
        _id: 'x',
        c2p: function(v) {
            return (_this.projection(v) || [])[0] - _this.xaxis._offset;
        }
    };

    _this.yaxis = {
        _id: 'y',
        c2p: function(v) {
            return (_this.projection(v) || [])[1] - _this.yaxis._offset;
        }
    };

    // mock axis for hover formatting
    _this.mockAxis = {
        type: 'linear',
        showexponent: 'all',
        exponentformat: 'B'
    };
    Axes.setConvert(_this.mockAxis, fullLayout);
};

// [hot code path] (re)draw all paths which depend on the projection
proto.render = function() {
    var projection = this.projection;
    var pathFn = projection.getPath();
    var k;

    function translatePoints(d) {
        var lonlatPx = projection(d.lonlat);
        return lonlatPx ?
            'translate(' + lonlatPx[0] + ',' + lonlatPx[1] + ')' :
             null;
    }

    function hideShowPoints(d) {
        return projection.isLonLatOverEdges(d.lonlat) ? 'none' : null;
    }

    for(k in this.basePaths) {
        this.basePaths[k].attr('d', pathFn);
    }

    for(k in this.dataPaths) {
        this.dataPaths[k].attr('d', function(d) { return pathFn(d.geojson); });
    }

    for(k in this.dataPoints) {
        this.dataPoints[k]
            .attr('display', hideShowPoints)
            .attr('transform', translatePoints);
    }
};

// Helper that wraps d3.geo[/* projection name /*]() which:
//
// - adds 'fitExtent' (available in d3 v4)
// - adds 'getPath', 'getBounds' convenience methods
// - scopes logic related to 'clipAngle'
// - adds 'isLonLatOverEdges' method
// - sets projection precision
// - sets methods that aren't always defined depending
//   on the projection type to a dummy 'd3-esque' function,
//
// This wrapper alleviates subsequent code of (many) annoying if-statements.
function getProjection(geoLayout) {
    var projLayout = geoLayout.projection;
    var projType = projLayout.type;

    var projection = d3.geo[constants.projNames[projType]]();

    var clipAngle = geoLayout._isClipped ?
        constants.lonaxisSpan[projType] / 2 :
        null;

    var methods = ['center', 'rotate', 'parallels', 'clipExtent'];
    var dummyFn = function(_) { return _ ? projection : []; };

    for(var i = 0; i < methods.length; i++) {
        var m = methods[i];
        if(typeof projection[m] !== 'function') {
            projection[m] = dummyFn;
        }
    }

    projection.isLonLatOverEdges = function(lonlat) {
        if(projection(lonlat) === null) {
            return true;
        }

        if(clipAngle) {
            var r = projection.rotate();
            var angle = d3.geo.distance(lonlat, [-r[0], -r[1]]);
            var maxAngle = clipAngle * Math.PI / 180;
            return angle > maxAngle;
        } else {
            // TODO does this ever happen??
            return false;
        }
    };

    projection.getPath = function() {
        return d3.geo.path().projection(projection);
    };

    projection.getBounds = function(object) {
        return projection.getPath().bounds(object);
    };

    // adapted from d3 v4:
    // https://github.com/d3/d3-geo/blob/master/src/projection/fit.js
    projection.fitExtent = function(extent, object) {
        var w = extent[1][0] - extent[0][0];
        var h = extent[1][1] - extent[0][1];
        var clip = projection.clipExtent && projection.clipExtent();

        projection
            .scale(150)
            .translate([0, 0]);

        if(clip) projection.clipExtent(null);

        var b = projection.getBounds(object);
        var k = Math.min(w / (b[1][0] - b[0][0]), h / (b[1][1] - b[0][1]));
        var x = +extent[0][0] + (w - k * (b[1][0] + b[0][0])) / 2;
        var y = +extent[0][1] + (h - k * (b[1][1] + b[0][1])) / 2;

        if(clip) projection.clipExtent(clip);

        return projection
            .scale(k * 150)
            .translate([x, y]);
    };

    projection.precision(constants.precision);

    if(clipAngle) {
        projection.clipAngle(clipAngle - constants.clipPad);
    }

    return projection;
}

function makeGraticule(axisName, geoLayout) {
    var axisLayout = geoLayout[axisName];
    var dtick = axisLayout.dtick;
    var scopeDefaults = constants.scopeDefaults[geoLayout.scope];
    var lonaxisRange = scopeDefaults.lonaxisRange;
    var lataxisRange = scopeDefaults.lataxisRange;
    var step = axisName === 'lonaxis' ? [dtick] : [0, dtick];

    return d3.geo.graticule()
        .extent([
            [lonaxisRange[0], lataxisRange[0]],
            [lonaxisRange[1], lataxisRange[1]]
        ])
        .step(step);
}

// Returns polygon GeoJSON corresponding to lon/lat range box
// with well-defined direction
//
// Note that clipPad padding is added around range to avoid aliasing.
function makeRangeBox(lon, lat) {
    var clipPad = constants.clipPad;
    var lon0 = lon[0] + clipPad;
    var lon1 = lon[1] - clipPad;
    var lat0 = lat[0] + clipPad;
    var lat1 = lat[1] - clipPad;

    // to cross antimeridian w/o ambiguity
    if(lon0 > 0 && lon1 < 0) lon1 += 360;

    var dlon4 = (lon1 - lon0) / 4;

    return {
        type: 'Polygon',
        coordinates: [[
            [lon0, lat0],
            [lon0, lat1],
            [lon0 + dlon4, lat1],
            [lon0 + 2 * dlon4, lat1],
            [lon0 + 3 * dlon4, lat1],
            [lon1, lat1],
            [lon1, lat0],
            [lon1 - dlon4, lat0],
            [lon1 - 2 * dlon4, lat0],
            [lon1 - 3 * dlon4, lat0],
            [lon0, lat0]
        ]]
    };
}
