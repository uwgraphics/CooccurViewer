var gl = GL.create({width: 800, height: 800});

// colobrewer.RdBu['11'] set to luminance 65 (tol: 5)
// http://graphics.cs.wisc.edu/Projects/RampGen/build_ramps.html
var isoluminantRdBu = ["#EC7B8B", "#FF696B", "#F07C68", "#D38D6D", "#B59887", "#9E9E9E", "#8FA0AA", "#75A4BB", "#59A6D4", "#68A0E8", "#829ED9"];
var isoluminantRdBuFixedWhite = ["#EC7B8B", "#FF696B", "#F07C68", "#D38D6D", "#B59887", "#FFFFFF", "#8FA0AA", "#75A4BB", "#59A6D4", "#68A0E8", "#829ED9"];

// window.onload = main;

var timer = null;

var shaders = [];
var textures = [];
var overview, indicator, indicatorBackground;
var indicatorWidth = 0;
var indicatorHeight = 4;
var topMargin;

var useBivariate = false;
var chosenColormap;
var colormapRGBA;
var colormapTexture;
var colormapWidth = 0;

var dataDir = "";

var ds = {
  metrics: [],       // holds the raw dat for all metrics
  buffers: [],       // holds the WebGL buffers for all loaded data 
                     // (ds.buffers['pos'] is a special position buffer)
  bounds: [],        // holds the bounds for each metric, indexed by the n-th element
  ready: [],         // boolean value: is the request metric is fully loaded?
  numWindow: 0,      // the number of window positions in this dataset
  numPos: 0,         // the number of base positions in this dataset
  curMetric: "",     // the current metric drawn
  curAttenuation: "",// the current attentuation metric
  curCounts: []      // keeps track of all the count metrics (ints) loaded in
};

var screenOffset = [0, 0];
var scale = 1;
var offset = [0, 0];

// interaction state
var freezeZoom = false;
var detailPos = [3421, 3500];
var superZoomPos = [0, 0];

// general function to read in binary data
// assumes three header ints:
// <window_size> <num_pos> <header_flags>
// ... where <header_flags> is a 32-bit int:
//
//                     spacing (# data/element)
// precision (n/a for floats) __  |
//       is int? (n is float)__|  |
//                            ||  |
// is a sparse representation_||  |
//                           |||  |
// uuuuuuuuuuuuuuuuuuuuuuuuuusippnn
var loadBinaryData = function(data, name) {
  ds.ready[name] = false;
  
  console.time("parsing file " + name);

  var dv = new DataView(data);
  
  var thisNumWindow = dv.getInt32(0);
  var thisNumPos = dv.getInt32(4);
  
  // parse the header flags
  var headerFlagInt = dv.getInt32(8);
  // headerFlagInt >>= 8; // for some reason, java puts this stuff in the first two bytes?
  var thisSpacing = (headerFlagInt & 3) + 1;
  var precision = ((headerFlagInt & 12) >> 2) + 1;
  var isInt = (headerFlagInt & 16) > 0;
  var isSparse = (headerFlagInt & 32) > 0;
  
  // do some function definition here based on the header flags
  var headerSize = 12;
  var getDataVal = function(offset) { return DataView.prototype.getFloat32.call(dv, offset); };
  if (isInt) {
    getDataVal = function(offset) { return DataView.prototype.getInt32.call(dv, offset); };
    if (precision == 2) {
      getDataVal = function(offset) { return DataView.prototype.getInt16.call(dv, offset); };
    } else if (precision == 1) {
      getDataVal = function(offset) { return DataView.prototype.getInt8.call(dv, offset); };
    }
  } else {  
    precision = 4;
  }
  
  // do a bunch of error checking (also serves as documentation)
  if (ds.numPos && ds.numPos != thisNumPos) {
    console.warn("number of lines in file %s does not match data: expected %d, depth had %d lines", name, ds.numWindow, thisNumWindow);
  }
  
  if (ds.numWindow && ds.numWindow != thisNumWindow) {
    console.warn("number of items in a window does not match data in %s: expected %d, depth had a window size of %d", name, ds.numWindow, thisNumWindow);
  }
  
  var expectedPositions = 0;
  if (isSparse) {
    expectedPositions = (dv.byteLength - headerSize) / (thisSpacing * precision + 4);
    if (expectedPositions % 1 != 0) {
      console.warn("expected to find %d positions of data, found a fraction of %f extra data (each element has %d data values associated of %d bytes of precision each)", expectedPositions, expectedPositions % 1, thisSpacing, precision);
      
      expectedPositions = Math.floor(expectedPositions);
    }
  } else {
    var expectedBytes = (thisNumWindow * thisNumPos * thisSpacing) * precision + headerSize;
    if (dv.byteLength !== expectedBytes) {
      console.warn("expected to find %d bytes of data from header, found %d instead. unusual truncation may occur", dv.byteLength, expectedBytes);
      
      if (dv.byteLength < expectedBytes) {
        console.error("missing data designated by header, please check the file. aborting.");
        return false;
      }
    }
  }
  
  // if we don't have any population of numWindow and numPos, 
  // populate it with this dataset.
  var windowOffset = 0;
  var numPositions = thisNumPos;
  if (ds.numWindow == 0 || ds.numPos == 0) {
    ds.numWindow = thisNumWindow;
    ds.numPos = thisNumPos;
    
    // create a position buffer with all possible positions
    var positions = new Float32Array(ds.numPos * ds.numWindow * 2);
    for (var i = 0; i < ds.numPos; i++) {
      for (var j = 0; j < ds.numWindow; j++) {
        var curIndex = (i * ds.numWindow + j) * 2;
        positions[curIndex] = i;
        positions[curIndex + 1] = j;
      }
    }
    
    // load the position buffer
    ds.buffers['pos'] = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
    ds.buffers['pos'].buffer = gl.createBuffer();
    ds.buffers['pos'].buffer.length = ds.numPos * ds.numWindow * 2;
    ds.buffers['pos'].buffer.spacing = 2;
    
    gl.bindBuffer(ds.buffers['pos'].target, ds.buffers['pos'].buffer);
    gl.bufferData(ds.buffers['pos'].target, positions, gl.STATIC_DRAW);
  } else {
    windowOffset = (ds.numWindow - thisNumWindow) / 2;
    numPositions = Math.min(ds.numPos, thisNumPos);
  }

  // always use a Float32Array; Javascript stores things as floats anyway, and
  // WebGL doesn't like integer arrays in shaders when they're not indices (?!)
  ds.metrics[name] = new Float32Array(ds.numPos * ds.numWindow * thisSpacing);
  ds.bounds[name] = [];
  for (var n = 0; n < thisSpacing; n++) {
    ds.bounds[name][n] = [];
    ds.bounds[name][n][0] = 10000;
    ds.bounds[name][n][1] = -10000;
  }
  
  // explode out the sparse representation to a full representation for the GPU
  var offset = headerSize;
  if (isSparse) {
    for (var i = 0; i < expectedPositions; i++) {
      var curIndex = dv.getInt32(offset);
      offset += 4;
      
      curIndex *= thisSpacing;
      
      for (var n = 0; n < thisSpacing; n++) {
        var curVal = getDataVal(offset);
        ds.metrics[name][curIndex + n] = curVal;
        
        ds.bounds[name][n][0] = Math.min(ds.bounds[name][n][0], curVal);
        ds.bounds[name][n][1] = Math.max(ds.bounds[name][n][1], curVal);
        
        offset += precision;
      }
    }
  } else { // assume a list of elements and read them off sequentially
    for (var i = 0; i < numPositions; i++) {
      for (var j = windowOffset; j < ds.numWindow - windowOffset; j++) {
        var curIndex = (i * ds.numWindow + j) * thisSpacing;
        for(var n = 0; n < thisSpacing; n++) {
          var curVal = getDataVal(offset);
          ds.metrics[name][curIndex + n] = curVal;
          
          ds.bounds[name][n][0] = Math.min(ds.bounds[name][n][0], curVal);
          ds.bounds[name][n][1] = Math.max(ds.bounds[name][n][1], curVal); 
          
          offset += precision;
        }
      }
    }
  }
  
  ds.buffers[name] = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buffers[name].buffer = gl.createBuffer();
  ds.buffers[name].buffer.length = ds.numPos * ds.numWindow * thisSpacing;
  ds.buffers[name].buffer.spacing = thisSpacing;
  
  gl.bindBuffer(ds.buffers[name].target, ds.buffers[name].buffer);
  gl.bufferData(ds.buffers[name].target, ds.metrics[name], gl.STATIC_DRAW);
  
  gl.bindBuffer(ds.buffers[name].target, null);
  
  console.timeEnd("parsing file " + name);
  
  ds.ready[name] = true;
  
  // iff we already have loaded the attenuation and metric, 
  // refresh the legend for the new bounds
  if (ds.ready[ds.curMetric] && ds.ready[ds.curAttenuation])
    updateLegend();
  
  gl.ondraw();
  return true;
};

// get the current metric's values for the given coordinate
var debugPoint = function(x, y) {
  var wIndex = x - y + Math.floor(ds.numWindow / 2);
  
  // throw an error if the corresponding y value falls outside the loaded window
  if (wIndex < 0 || wIndex >= ds.numWindow) {
    // console.log("tried to access out of bounds value, (%d, %d)", x, y);
    return false;
  }
  
  console.log("got wIndex: %d", wIndex);
  
  var curSpacing = ds.buffers[ds.curMetric].buffer.spacing;
  var curIndex = (y * ds.numWindow + wIndex) * curSpacing;
  
  var ret = [];
  for (var i = 0; i < curSpacing; i++) {
    ret[i] = ds.metrics[ds.curMetric][curIndex + i];
  }
  
  return ret;
};

// construct a Uint8 buffer for all hex-encoded colors given a specified
// colorbrewer ramp.
var colorbrewerRampToBuffer = function(colors, width) {
  var arr = new Uint8Array(width * width * 4);
  
  colors.forEach(function(color, n) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color);
    arr[n * 4]     = parseInt(result[1], 16);
    arr[n * 4 + 1] = parseInt(result[2], 16);
    arr[n * 4 + 2] = parseInt(result[3], 16);
    arr[n * 4 + 3] = 255;
  });
  
  return arr;
};

// creates a texture with the specified colorbrewer ramp
var colorbrewerRampToTexture = function(colors, doReverse) {
  // if requested to do a reverse, make a copy and reverse that
  if (doReverse) {
    colors = Array.prototype.slice.call(colors).reverse();
  }
  
  // set the current colorbrewer ramp to the given colors
  chosenColormap = colors;

  var w = Math.ceil(Math.sqrt(colors.length));
  colormapTexture = new GL.Texture(w, w, {filter: gl.NEAREST, wrap: gl.CLAMP_TO_EDGE});
  
  // Unset variable set by lightgl.js in TEXTURE.js;
  // see <http://code.google.com/p/chromium/issues/detail?id=125481>
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  
  colormapRGBA = colorbrewerRampToBuffer(colors, w);  
  
  colormapTexture.bind(0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, w, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapRGBA);
  colormapTexture.unbind(0);
  
  // this seems a good of a place as any to drop this
  updateLegend();

  colormapWidth = w;
};

// given an absolute position x, y (e.g. the actual positions of i and j; j is NOT
// an index into the window), return the n-th value from the current metric
var getDataValueFromAbsolutePosition = function(i, j, n) {
  // default to the first value (if 1-D metric)
  n = n || 0;
  
  // have to convert from absolute y to a window index;
  // y = x corresponds to Math.floor(ds.numWindow / 2)
  var wIndex = j - i + Math.floor(ds.numWindow / 2);
  
  // throw an error if the corresponding y value falls outside the loaded window
  if (wIndex < 0 || wIndex >= ds.numWindow) {
    // console.log("tried to access out of bounds value, (%d, %d)", x, y);
    return false;
  }
  
  var curData = ds.metrics[ds.curMetric];
  var curSpacing = ds.buffers[ds.curMetric].buffer.spacing;
  
  return curData[(i * ds.numWindow + wIndex) * curSpacing + n];
};

// given a x position (position number) and a y value (window value) and optionally
// the n-th value (defaults to 0), get the color that represents the n-th value
var getColorForPosition = function(x, y, n) {
  n = n || 0;
  var curSpacing = ds.buffers[ds.curMetric].buffer.spacing;
  var curIndex = (x * ds.numWindow + y) * curSpacing + n;
  
  var data = ds.metrics[ds.curMetric][curIndex];
  
  return getColorFromDataValue(data);  
}

// given a particular value, return the color [r,g,b,a]
// that represents this value
var getColorFromDataValue = function(value) {
  var arr = [];
  
  if ($("#usecolorbrewer").prop('checked')) {
    // clamp min and max to lowest and highest ramp positions, respectively.
    var curMin = ds.bounds[ds.curMetric][0][0];
    var curMax = ds.bounds[ds.curMetric][0][1];
    
    var cbIndex = 0;
    if (value <= curMin)
      cbIndex = 0;
    else if (value >= curMax)
      cbIndex = chosenColormap.length - 1;
    else if (value == 0 && useBivariate) {
      cbIndex = Math.floor(chosenColormap.length / 2);
      //console.log("mid value");
    } else
      cbIndex = Math.floor((value - curMin) / (curMax - curMin) * (chosenColormap.length - 2)) + 1;
    
    // the stride is 4!
    cbIndex *= 4;
      
    arr = [colormapRGBA[cbIndex], colormapRGBA[cbIndex + 1], colormapRGBA[cbIndex + 2], 255];
    
  } else {
    arr = [value / ds.maxVal * 255, 0, 0, 255];
  }
  
  return arr;
};

// gets the variance matrix from positions i,j
// returns [modali_modalj, modali_varj, vari_modalj, vari_varj]
var getVarianceMatrixFromPositions = function(i, j, name) {
  var ret = {};
  
  ret['i'] = +i;
  ret['j'] = +j;
  
  name = name || "varCounts";
  if (!ds.ready[name]) {
    console.warn("getVarianceMatrixFromPositions() called before %s dataset ready", name);
    return false;
  }
  
  var wIndex = Math.floor(ds.numWindow / 2) + (j - i)
  if (wIndex < 0 || wIndex >= ds.numWindow) {
    console.warn("tried to access out of bounds counts from %s: (%d, %d), windowIndex: %d", name, i, j, wIndex);
    return false;
  }
  
  // four values per pair of positions
  var curIndex = (i * ds.numWindow + wIndex) * 4;
  
  ret['modali_modalj'] = ds.metrics[name][curIndex];
  ret['modali_varj']   = ds.metrics[name][curIndex + 1];
  ret['vari_modalj']   = ds.metrics[name][curIndex + 2];
  ret['vari_varj']     = ds.metrics[name][curIndex + 3];
  
  return ret;
};

// gets the currently selected buffers and creates a lightgl-compatible array
// for passing to `GL.Shader.drawBuffers();`.
var getCurrentBuffers = function() {
  var curBufs = [];
  curBufs['pos'] = ds.buffers['pos'];
  curBufs['metric'] = ds.buffers[ds.curMetric];
  curBufs['atten'] = ds.buffers[ds.curAttenuation];
  
  if ($("#dogating").prop('checked') && ds.ready['varCounts']) {
    curBufs['varCounts'] = ds.buffers['varCounts'];
  }
  
  return curBufs;
};

// TODO: shader doesn't support non-colorbrewer coloring mode
var constructOverviewTexture = function() {
  //console.time("constructing overview texture using WebGL drawing");
  
  // if the texture already exists, use it
  var curTexture = $("#usecolorbrewer").prop('checked') ? "lightOver" : "colorOver";
  
  // TODO
  if (!$("#usecolorbrewer").prop('checked')) {
    console.error("fillOverview shader does not support non-colorbrewer drawing");
    return;
  }
  
  // for datasets with numPos less than gl.canvas.width, force to still 
  // draw a rectangle (e.g. don't let texHeight go too high)
  var effNumPos = Math.max(ds.numPos, gl.canvas.width);
  
  if (!textures[curTexture]) {
    var texHeight = gl.canvas.width * ds.numWindow / effNumPos;
    textures[curTexture] = new GL.Texture(gl.canvas.width, texHeight);
  }
  
  // default to non-gated
  var shader = shaders['fillOverview'];
  if ($("#dogating").prop('checked') && ds.ready['varCounts'])
    shader = shaders['fillOverviewGated'];
  
  var curBufs = getCurrentBuffers();
  textures[curTexture].drawTo(function() {
    var bivar = useBivariate ? 1 : 0;
    var darken = $("#dodarkening").prop('checked') ? 1 : 0;
    
    if (darken)
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
    else
      gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    colormapTexture.bind(0);
    
    shader.uniforms({
      dataSize: [effNumPos, ds.numWindow],
      minVal: ds.bounds[ds.curMetric][0][0],
      maxVal: ds.bounds[ds.curMetric][0][1],
      maxAtten: ds.bounds[ds.curAttenuation][0][1],
      bivariate: bivar,
      darkening: darken,
      gateLimit: $("#gateLevel").val() / 100,
      rampTexWidth: colormapWidth,
      numSteps: chosenColormap.length,
      colorRamp: 0
    }).drawBuffers(curBufs, null, gl.POINTS);
    
    colormapTexture.unbind(0);
  });
  
  // compute how many y-pixels the overview + indicator takes up
  topMargin = Math.floor((ds.numWindow / effNumPos) * gl.canvas.width) + indicatorHeight + 1;
  
  updateAxisLabels();
  
  //console.timeEnd("constructing overview texture using WebGL drawing");
};

var setInitBounds = function() {
  console.error("function not supported by any shader");
  
  var b = [[0, 344], [0, 301]];
  
  offset = [-(b[0][0] + b[0][1]) / 2.0, -(b[1][0] + b[1][1]) / 2.0];
  
  scale = Math.max(b[0][1] - b[0][0], b[1][1] - b[1][0]);
  scale = gl.canvas.height / scale;
  
  screenOffset = [gl.canvas.width / 2.0, gl.canvas.height / 2.0];
};

var setZoomPan = function() {
  gl.loadIdentity();
  // gl.rotate(-45, 0, 0, 1);
  if ($("#dodiagonal").prop('checked')) {
    // give an upper margin of 100 pixels
    gl.translate(0, (topMargin - gl.canvas.height) * (scale - 1), 0);
    gl.scale(scale, -scale, 1);
    gl.translate(screenOffset[0], screenOffset[0] - gl.canvas.height + topMargin, 0);
  } else {
    gl.translate(screenOffset[0], screenOffset[1], 0);
    gl.scale(scale, scale, 1);
  }
};

var debugTexture = function(tex, x, y, w, h, nodebug) {
  // Be a little lenient with texture, allow passing in GL.Texture (lightgl).
  if (Object.prototype.toString.call(tex).indexOf("WebGLTexture") == -1)
    tex = tex.id;

  w = w || 2;
  h = h || 2;
  ds.fbo = ds.fbo || gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, ds.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  
  var pixels = new Uint8Array(w * h * 4);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) == gl.FRAMEBUFFER_COMPLETE) {
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (!nodebug) {
      console.log("Reading from texture coords (" + x + ", " + y + ") to (" + (x+w) + ", " + (y+h) + "):");
      console.log(pixels);
    }
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return pixels;
};

// each x is worth this much in numPos
var transformOverviewX = function(x) {
  return x * (ds.numPos / gl.canvas.width);
};

var untransformX = function(x) {
  return x * (gl.canvas.width / ds.numPos);
};

var texturesCreated = false;
var createTextures = function() {
  var defaultOpts = {
    magFilter: gl.LINEAR,
    minFilter: gl.NEAREST,
    format:    gl.RGBA,
    type:      gl.UNSIGNED_BYTE
  };
  
  // create the colorbrewer ramp texture so the shader can access values
  colorbrewerRampToTexture(chosenColormap);
  
  // size the overview rectangle to not skew overview data
  overview = new GL.Mesh.plane();
  
  // force minimium height if numPos < gl.canvas.width
  y_min = 1 - ((ds.numWindow / Math.max(ds.numPos, gl.canvas.width)) * 2);
  overview.vertices[0][1] = y_min;
  overview.vertices[1][1] = y_min;
  
  overview.compile();
  
  // create the overview window indicator 
  // (what detail are we showing from overview?)
  indicator = new GL.Mesh.plane();
  indicatorHeight = 7;
  
  // set the y positions based on the size of the overview
  indicator.vertices[0][1] = 
    indicator.vertices[1][1] = y_min - (2 * indicatorHeight / gl.canvas.height);
  indicator.vertices[2][1] = indicator.vertices[3][1] = y_min;
  
  // update the x-coordinates of vertices, and compile
  updateIndicator(true);
  indicator.compile(gl.DYNAMIC_DRAW);
  
  indicatorBackground = new GL.Mesh.plane();
  indicatorBackground.vertices[0][1] = 
    indicatorBackground.vertices[1][1] = indicator.vertices[0][1];
  indicatorBackground.vertices[2][1] = 
    indicatorBackground.vertices[3][1] = indicator.vertices[2][1];
    
  // set the z-value of the indicator background so it is drawn behind the indicator
  for (var i = 0; i < 4; i++) {
    indicatorBackground.vertices[i][2] = 0.0;
  }
  indicatorBackground.compile(gl.STATIC_DRAW);
  
  // clean up state
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  texturesCreated = true;
};

var updateIndicator = function(setupOnly) {
  indicatorWidth = $("#dodiagonal").prop('checked') ? 2 * (gl.canvas.height - indicatorHeight - topMargin) / ds.numPos / scale : 2 * (gl.canvas.width / ds.numPos) / scale;
  
  // get the current 'x pos'
  var xpos = -screenOffset[0];
  indicator.vertices[0][0] = indicator.vertices[2][0] = 2 * (xpos / ds.numPos) - 1;
  indicator.vertices[1][0] = indicator.vertices[3][0] = indicator.vertices[0][0] + indicatorWidth;
  
  // try to avoid recompiling; we already told WebGL the vertex buffer of indicator
  // was `gl.DYNAMIC_DRAW`, now let's just update the buffer.  
  if (!setupOnly) {
    gl.bindBuffer(gl.ARRAY_BUFFER, indicator.vertexBuffers.gl_Vertex.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([].concat.apply([], indicator.vertices)));
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }
  
  //indicator.compile(gl.STREAM_DRAW);  
};

gl.ondraw = function() {
  var ptShader = $("#dodiagonal").prop('checked') ? shaders['pointsDiag'] : shaders['points'];
  
  /*var cbPtShader = $("#dodiagonal").prop('checked') ? 
    ($("#dogating").prop('checked') ? shaders['cb_PointsDiagGated'] : shaders['cb_pointsDiag']) 
      : shaders['cb_points'];*/
      
  var cbPtShader = shaders['cb_points'];
  if ($("#dodiagonal").prop('checked')) {
    if ($("#dogating").prop('checked')) {
      cbPtShader = shaders['cb_pointsDiagGated'];
    } else {
      cbPtShader = shaders['cb_pointsDiag'];
    }
  }

  if (!ds.buffers['pos'] || !ds.ready[ds.curMetric] || !ds.ready[ds.curAttenuation] ||
      !ptShader || !cbPtShader || 
      !shaders['overview'] || !shaders['solid'] || 
      !shaders['fillOverview'] || !shaders['fillOverviewGated']) 
  {
    timer = setTimeout("gl.ondraw()", 300);
    return;
  }
  
  if (!texturesCreated) {
    createTextures();
  }
  
  hideLoading();
  
  console.time("gl.ondraw()");
  
  constructOverviewTexture();
  
  // based on screenOffset, update the overview indicator
  updateIndicator();
  
  gl.clearColor(0.9, 0.9, 0.9, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  
  // get ready to draw the full-detailed matrix diagonal
  gl.pushMatrix();
  gl.matrixMode(gl.MODELVIEW);
  setZoomPan(); // unused right now...
  
  var curBufs = getCurrentBuffers();
  if ($("#usecolorbrewer").prop('checked')) {
    colormapTexture.bind(0);
    var bivar = useBivariate ? 1 : 0;
    var darken = $("#dodarkening").prop('checked') ? 1 : 0;
    var confid = $("#doconfidence").prop('checked') ? 1 : 0;
    var binL = $("#dolightbinning").prop('checked') ? 1 : 0;
    cbPtShader.uniforms({
      pointSize: scale,
      windowSize: ds.numWindow,
      minVal: ds.bounds[ds.curMetric][0][0], 
      maxVal: ds.bounds[ds.curMetric][0][1],
      maxAtten: ds.bounds[ds.curAttenuation][0][1],
      gateLimit: $("#gateLevel").val() / 100,
      bivariate: bivar,
      darkening: darken,
      confidence: confid,
      binLight: binL,
      rampTexWidth: colormapWidth,
      numSteps: chosenColormap.length,
      colorRamp: 0
    }).drawBuffers(curBufs, null, gl.POINTS);
    colormapTexture.unbind(0);
  } else {
    console.error("unimplemented; needs a shader update");
    ptShader.uniforms({
      pointSize: 1,
      windowSize: ds.numWindow,
      maxVal: ds.maxVal
    }).drawBuffers(vertBuffer, null, gl.POINTS);
  }
  
  gl.popMatrix();
  
  // draw the overview
  var curTexture = $("#usecolorbrewer").prop('checked') ? "lightOver" : "colorOver";
  textures[curTexture].bind(0);
  shaders['overview'].uniforms({
    texture: 0,
    minVal: y_min
  }).draw(overview);
  textures[curTexture].unbind(0);  
  
  // draw the indicator
  shaders['solid'].uniforms({
    vColor: [133/255, 200/255, 35/255, 1]
  }).draw(indicator);
  
  // draw the indicator background
  shaders['solid'].uniforms({
    vColor: [0.9, 0.9, 0.9, 1]
  }).draw(indicatorBackground);
  
  
  /*
  var p = new GL.Mesh.plane();
  colormapTexture.bind(0);
  shaders['texture'].uniforms({
    texture: 0
  }).draw(p);
  colormapTexture.unbind(0);
  */
  console.timeEnd("gl.ondraw()");
}

var resizeCanvas = function() {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.matrixMode(gl.PROJECTION);
  gl.loadIdentity();
  gl.ortho(0, gl.canvas.width, 0, gl.canvas.height, -100, 100);
  gl.matrixMode(gl.MODELVIEW);
};

var setCleanXInput = function(x) {
  // the minimum position that the slider can take
  var halfIndicator = indicatorWidth / 2 * gl.canvas.width / 2;
  
  // always translate x so that it's moving the 'middle' of the slider
  x -= halfIndicator;
  
  // set the screenOffset with the modified x
  if (!$("#dodiagonal").prop('checked')) {
    screenOffset[0] = -transformOverviewX(
      Math.max(0, 
        Math.min(gl.canvas.width - 2 * halfIndicator, x)));
  } else {
    screenOffset[0] = -transformOverviewX(
      Math.max(0, 
        Math.min(gl.canvas.width, x)));
  }
};

// adds spaces to delineate thousands (only when >=5 digits)
// .. does not handle decimals
var spacify = function(number) {
  number = number + "";
  if (number.length >= 5) {
    number = number.replace(/(\d)(?=(\d{3})+$)/g, '$1 ');
  }
  
  return number;
};

var updateAxisLabels = function() {
  var xmin = Math.floor(-screenOffset[0]);
  var xmax = Math.floor(-screenOffset[0] + gl.canvas.width / scale);
  
  // data up to this point is 0-indexed; use 1-index for display
  $("#label-xmin").html(spacify(xmin + 1));
  $("#label-xmax").html(spacify(xmax + 1));
  if ($("#dodiagonal").prop('checked')) {
    var ymin = xmin;
    var ymax = Math.floor(ymin + (gl.canvas.height - topMargin) / scale);
    
    $("#label-ymin").html(spacify(ymin));
    $("#label-ymax").html(spacify(ymax));
  } else {
    console.warn("axis labels not implemented for non-diagonal representations");
  }
};

var handleSuperZoomClick = function() {
  // assume `this` is the div in the superZoom was clicked...
  // first, determine which child this is
  var i = Array.prototype.indexOf.call(this.parentNode.children, this);
  
  // get the offset from the center pixel
  var di = (i % 3) - 1;
  var dj = Math.floor(i / 3) - 1;
  
  // set the detail position and call the function to update the detail view
  detailPos = [superZoomPos[1] + di, superZoomPos[0] + dj];
  updateDetail();
};

var populateSuperZoom = function() {
  var sZContainer = document.getElementById("super-zoom");
  var colors = colorbrewer.Pastel1['9'];
  for (var i = 0; i < 9; i++) {
    var newPixel = document.createElement("div");
    newPixel.className = "pixel" + i;
    newPixel.style.backgroundColor = colors[i];
    sZContainer.appendChild(newPixel);
    newPixel.addEventListener('click', handleSuperZoomClick);
    
    var newValue = document.createElement("span");
    newValue.className = "val";
    newValue.innerHTML = "--";
    newPixel.appendChild(newValue);
    
    var newCoord = document.createElement("span");
    newCoord.className = "coord";
    newCoord.innerHTML = "(0,0)";
    newPixel.appendChild(newCoord);
  }
};

var updateSuperZoom = function() {
  superZoomPos = convertScreenToDataCoords();
  
  var sZContainer = document.getElementById("super-zoom");
  for (var n = 0; n < 9; n++) {
    var curPixel = sZContainer.children[n];
    
    var dy = (n % 3) - 1;
    var dx = Math.floor(n / 3) - 1;
    
    var y = superZoomPos[0] + dx;
    var x = superZoomPos[1] + dy;
    
    var curVal = getDataValueFromAbsolutePosition(x, y);
    
    if (curVal === false) {
      curPixel.style.backgroundColor = "#000";
      curPixel.children[1].innerHTML = "";
      curPixel.children[0].innerHTML = "--";
    } else {
      var c = getColorFromDataValue(curVal);
      curPixel.style.backgroundColor = "rgb("+c[0]+","+c[1]+","+c[2]+")";
      
      // data is all 0-indexed up to this point; convert to 1-index for display
      curPixel.children[1].innerHTML = "("+(x+1)+", "+(y+1)+")";
      curPixel.children[0].innerHTML = curVal.toFixed(3);
    }
  }
};

// translate from panX, panY to data coordinates; what data is our mouse over?
var convertScreenToDataCoords = function() {
  var xval, yval;

  if ($("#dodiagonal").prop('checked')) {
    var xmin = Math.floor(-screenOffset[0]);
    var ymin = xmin;
    
    xval = (panX / scale) + xmin;
    yval = ((gl.canvas.height - panY) - topMargin) / scale + ymin;
  } else { // TODO: implement
    xval = -1;
    yval = -1;
  }
  
  return [Math.floor(yval), Math.floor(xval)];
};

// do this outside (this is the D3 thing to do?!)
var svg = d3.select("#legend")
  .append('g')
    .attr('id', 'swatchgrp')
    .attr('transform', 'translate(45, 25)');
    
// also make an x-axis group    
svg.append('g')
  .attr('class', 'axis metric-axis')
  .attr('transform', 'translate(0, -2)');
  
svg.append('g')
  .attr('class', 'axis attenuation-axis')
  .attr('transform', 'translate(-2, 0)');

// update legend with the current colorramp (uses D3.js)
var updateLegend = function() {
  // the data we're using is the 'chosenColormap'; assume it's been populated by this point
  
  var svgWidth = 200, svgHeight = 200;
  
  var margin = 2;
  var effWidth = svgWidth - margin;
  var effHeight = svgHeight - margin;
  
  var numLightBins = 11;  
  var scales = [];
  
  if (ds.ready[ds.curMetric]) {
    var metricScale = d3.scale.linear()
      .domain(ds.bounds[ds.curMetric][0])
      .range([19, 181]);
      
    var metricAxis = d3.svg.axis()
      .scale(metricScale)
      .orient('top')
      .tickFormat(d3.format(".1f"))
      .ticks(6);
      
    svg.select("g.metric-axis")
      .call(metricAxis);
  }
  
  if (ds.ready[ds.curAttenuation]) {
    var bounds = ds.bounds[ds.curAttenuation][0];
  
    var attenScale = d3.scale.linear()
      .domain([bounds[1], bounds[0]])
      .range([19, 181]);
      
    var attenAxis = d3.svg.axis()
      .scale(attenScale)
      .orient('left')
      .ticks(6);
      
    svg.select("g.attenuation-axis")
      .call(attenAxis);
  }
      
  // remove any existing color key from the svg
  svg.selectAll('.swatch').remove();
  
  var swatchGroup = svg.selectAll('.swatch').data(chosenColormap).enter()
    .append('g')
      .attr('class', 'swatch')
      .attr('transform', function(d, i) {
        var x = i * (effWidth / chosenColormap.length) + margin;
        return "translate(" + x + "," + margin + ")";
      });
     
  // do the first level
  swatchGroup.append('rect')
    .attr('width', effWidth / chosenColormap.length - margin)
    .attr('height', effHeight / numLightBins - margin)
    .attr('y', 0)
    .attr('x', 0)
    .attr('fill', function(d, i) { 
      var mixColor = $("#dodarkening").prop('checked') ? "black" : "white";
      scales[i] = d3.scale.linear()
        .range([d, mixColor])
        .interpolate(d3.interpolateLab);
      return d; 
    });
    
  // do the second level
  for (var n = 1; n < numLightBins; n++) {  
    swatchGroup.append('rect')
      .attr('width', effWidth / chosenColormap.length - margin)
      .attr('height', effHeight / numLightBins - margin)
      .attr('y', n * effHeight / numLightBins)
      .attr('x', 0)
      .attr('fill', function(d, i) {
        return scales[i](0.1 * n); 
      });
    }
};


var detailSVG = d3.select("#detail")
  .append('g')
    .attr('transform', 'translate(25, 20)')

var updateDetail = function() {
  var getTotalReadsInPair = function(data) { 
    var totalReads = 0;
    data.forEach(function(d) {
      var foundReads = d.var + d.modal;
      if (totalReads && foundReads != totalReads) {
        console.error("error in counts; the total reads for i (%d) doesn't match j (%d)", totalReads, foundReads);
      }
      
      totalReads = foundReads;
    });
    
    console.log("found %d reads", totalReads);
    return totalReads;
  };
  
  // for each position, condition on the other position and what this
  // position reads looks like
  var parseMetadata = function(data) {
    var ret = [];
    
    ret[0] = {};
    ret[0]['pos'] = data.i;
    ret[0]['modal'] = data.modali_modalj + data.modali_varj;
    ret[0]['var'] = data.vari_modalj + data.vari_varj;
    ret[0]['ovar_var'] = data.vari_varj;
    ret[0]['omodal_var'] = data.vari_modalj;
    
    ret[1] = {};
    ret[1]['pos'] = data.j;
    ret[1]['modal'] = data.modali_modalj + data.vari_modalj;
    ret[1]['var'] = data.modali_varj + data.vari_varj;
    ret[1]['ovar_var'] = data.vari_varj;
    ret[1]['omodal_var'] = data.modali_varj;
    
    console.log("this position i = %d has %f % variant", data.i, Math.round(ret[0]['var'] / (ret[0]['var'] + ret[0]['modal']) * 10000) / 100);
    
    return ret;
  };
  
  var handleCondClick = function(thisRect, isVarRect) {
    var curLabel, otherLabel;
    if (isVarRect) {
      curLabel = '.label-var';
      otherLabel = '.label-modal';
    } else {
      curLabel = '.label-modal';
      otherLabel = '.label-var';
    }
    
    // immediately give this rectangle a class so we can disambiguate
    d3.select(thisRect).classed('conditioned');
    var condElement = thisRect;
    var totalCondReads = isVarRect ? 
      d3.select(thisRect).datum().var : d3.select(thisRect).datum().modal;
      
    // this can't be the most d3-ish way to do this...
    var parentGrpNode = d3.select(thisRect)[0][0].parentNode;
    d3.select(parentGrpNode).selectAll('rect')
      .transition().duration(250)
      .attr('width', 0)
      .attr('x', 0);
      
    // expand the clicked-on element to take up the full width
    d3.select(thisRect)
      .transition().duration(250)
      .attr('width', effWidth)
      .attr('x', 0);
    
    // move labels as well
    d3.select(parentGrpNode).selectAll(curLabel)
      .transition().duration(250)
      .attr('x', 0);  
      
    d3.select(parentGrpNode).selectAll(otherLabel)
      .text("");
    
    // get the rectangles to update
    var toUpdate = d3.selectAll('g.distribution')
      .filter(function() { return this !== parentGrpNode; })
      
    // make a new scale based on totalCondReads
    var cond_x = d3.scale.linear()
      .domain([0, totalCondReads])
      .range([0, effWidth]);
      
    // update the modal stuff
    var condVarReads = function(d) {
      return isVarRect ? d.ovar_var : d.omodal_var
    };
    
    var condModalReads = function(d) {
      return isVarRect ? 
        totalCondReads - d.ovar_var : totalCondReads - d.omodal_var;
    };
    
    toUpdate.selectAll('.pos-modal')
      .transition().delay(300)
      .attr('width', function(d) { return cond_x(condModalReads(d)); });
      
    toUpdate.selectAll('.label-modal')
      .transition().delay(300)
      .text(function(d) { return (condModalReads(d)); });
    
    toUpdate.selectAll('.pos-var')
      .transition().delay(300)
      .attr('x', function(d) { return cond_x(condModalReads(d)); })
      .attr('width', function(d) { return cond_x(condVarReads(d)); });
      
    toUpdate.selectAll('.label-var')
      .transition().delay(300)
      .attr('x', function(d) { return cond_x(condModalReads(d)); })
      .text(function(d) { return condVarReads(d); });
  }
  
  // remove any existing elements
  d3.selectAll('g.distribution').remove();
  
  var matrixData = getVarianceMatrixFromPositions(detailPos[0], detailPos[1]);
  if (matrixData === false) {
    console.error("failed to load variance matrix data for %d, %d", detailPos[0], detailPos[1]);
    return;
  }
  
  var exData = parseMetadata(matrixData);
  
  var svgWidth = 250, svgHeight = 150;
  
  var margin = 10;
  var effWidth = svgWidth - 25 - margin;
  var effHeight = svgHeight - margin;
  
  var barHeight = effHeight / 2;
  
  var x = d3.scale.linear()
    .domain([0, getTotalReadsInPair(exData)])
    .range([0, effWidth]);
  
  var bar = detailSVG.selectAll("g")
    .data(exData)
    .enter().append('g')
      .attr('class', 'distribution')
      .attr('transform', function(d, i) {
        return "translate(0," + i * barHeight + ")";
      });
    
  // append the variant stuff
  bar.append('rect')
    .attr('class', 'pos-var')
    .attr('x', function(d) { return x(d.modal); })
    .attr('width', function(d) { return x(d.var); })
    .attr('height', barHeight - 20)
    .on('click', function() {
      handleCondClick(this, true);
    });
    
  bar.append('text')
    .attr('class', 'label-var')
    .attr('y', -3)
    .attr('x', function(d) { return x(d.modal); })
    .text(function(d) { return d.var; });
    
  // append the modal stuff
  bar.append('rect')
    .attr('class', 'pos-modal')
    .attr('x', 0)
    .attr('width', function(d) { return x(d.modal); })
    .attr('height', barHeight - 20)
    .on('click', function() {
      handleCondClick(this, false);
    });
    
  bar.append('text')
    .attr('class', 'label-modal')
    .attr('y', -3)
    .attr('x', 0)
    .text(function(d) { return d.modal; });
    
  // append some description text
  bar.append('text')
    .attr('x', -5)
    .attr('y', (barHeight - 15) / 2)
    .attr('transform', "rotate(270, -5, " + ((barHeight - 15)/2) + ")")
    .style('text-anchor', 'middle')
    .text(function(d) { return (d.pos + 1); }); // data is 0-indexed to this point,
                                                // changed to 1-index for display
};
  

// ## Handlers for mouse-interaction
// Handle panning the canvas.
var panX, panY;
var buttons = {};
gl.onmousedown = function(e) {
  buttons[e.which] = true;
  panX = e.x;
  panY = gl.canvas.height - e.y;
  
  if (e.which == 1 && e.y <= topMargin) {
    setCleanXInput(panX);
    updateAxisLabels();
    gl.ondraw();
  }

  // (un-)freeze the zoom
  if (e.which == 1 && e.y > topMargin) {
    updateSuperZoom();
    freezeZoom = !freezeZoom;
    $("#super-zoom").toggleClass("frozen");
  }
};

gl.onmousemove = function(e) {
  panX = e.x;
  panY = gl.canvas.height - e.y;
  
  if (drags(e)) {    
    if (e.y <= topMargin) {
      setCleanXInput(panX);
      updateAxisLabels();
      gl.ondraw();
    }
  } else if (ds.ready[ds.curMetric] && $("#dodiagonal").prop('checked') 
             && !freezeZoom) {
    if (e.y <= topMargin) {
      // blank out super-zoom
      var superPixels = document.getElementById("super-zoom").children;
      for (var i = 0; i < superPixels.length; i++) {
        superPixels[i].style.backgroundColor = "#000";
        superPixels[i].children[0].innerHTML = "--";
        superPixels[i].children[1].innerHTML = "";
      };
    } else {
      updateSuperZoom();
    }
  }
};

gl.onmouseup = function(e) {
  buttons[e.which] = false;
};

var drags = function(e) {
  for (var b in buttons) {
    if (Object.prototype.hasOwnProperty.call(buttons, b) && buttons[b]) return true;
  }  
};

var mwheel = function(e, delta, deltaX, deltaY) {
  e.preventDefault();
  
  var x = e.offsetX;
  var y = gl.canvas.height - e.offsetY;
  
  var oldScale = scale;  
  scale = deltaY > 0 ? scale * 2 : scale / 2;
  
  // update the x-position so that the current position under the mouse 
  // stays in roughly the same place
  var actualPos = (Math.abs(screenOffset[0]) + x / oldScale);
  var newStart = actualPos - (x / scale);
  screenOffset[0] = -1 * Math.floor(newStart);
  
  gl.ondraw();
};

var updateLoadingStatus = function(msg) {
  $("#loading").show();
  $("#status").html(msg);
};

var hideLoading = function() {
  $("#loading").hide();
  $("#status").html("");
};

// Function to handle asynchronous loading and compilation of shaders.
var loadShaderFromFiles = function(name, opt_vn, opt_fn, callback) {
  var vn = opt_vn || name + '.vs';
  var fn = opt_fn || name + '.fs';
  var shaderDir = 'shaders/';
  var vd, fd;
  $.get(shaderDir + vn, function(data) {
    vd = data;
    if (fd) {
      shaders[name] = new GL.Shader(vd, fd);
      if (callback)
        callback();
    }
  });
  $.get(shaderDir + fn, function(data) {
    fd = data;
    if (vd) {
      shaders[name] = new GL.Shader(vd, fd);
      if (callback)
        callback();
    }
  });
};

var reloadShader = function(name, vs, fs) {
  console.log("reloading shader " + name + "... ");
  delete shaders[name];
  
  loadShaderFromFiles(name, vs, fs, gl.ondraw);
};

var makeBinaryFileRequest = function(filename, name, doShort) {
  // if a specific name is given, use it; otherwise just use the filename 
  // as the identifier
  name = name || filename;
  
  // jQuery looks too hard here; it's not implemented yet for ArrayBuffer 
  // xhr requests, which is an HTML5 phenomenon:
  // http://www.artandlogic.com/blog/2013/11/jquery-ajax-blobs-and-array-buffers/
  var xhr = new XMLHttpRequest();
  xhr.open('GET', filename, true);
  xhr.responseType = 'arraybuffer';
  
  xhr.addEventListener('load', function() {
    if (xhr.status == 200) {
      if (doShort === true) {
        loadBinaryShortSparseData(xhr.response, name);
        $("#dogating").prop('disabled', false);
      } else {
        loadBinaryData(xhr.response, name);
      }
    } else {
      console.warning("failed to load requested file (status: %d)", xhr.status);
      console.trace();
    }
  });
  
  xhr.send(null);
};

// handles all the DOM setup (adding the canvas to the page).  
// all webgl state is handled by the next function (to help with WebGLContextLost)
function setup() {
  gl.canvas.id = "webglcanvas";
  var canvasContainer = document.getElementById("canvas-container");
  canvasContainer.insertBefore(gl.canvas, canvasContainer.children[0]);
  
  // set up WebGL state
  initWebGLResources();
  
  // add an event listener that tries to reinitialize WebGL
  // test with canvas.loseContext();
  gl.canvas.addEventListener("webglcontextlost", function(ev) { ev.preventDefault(); }, false);
  gl.canvas.addEventListener("webglcontextrestored", initWebGLResources, false);
  
  var changeColormap = function() {
    if (!useBivariate) {
      colorbrewerRampToTexture(colorbrewer.OrRd['9']);
    } else if ($("#useisoluminant").prop('checked')) {
      if ($("#fixwhitecenter").prop('checked')) {
        colorbrewerRampToTexture(isoluminantRdBuFixedWhite, true);
      } else {
        colorbrewerRampToTexture(isoluminantRdBu, true);
      }
    } else {
      colorbrewerRampToTexture(colorbrewer.RdBu['11'], true);
    }
    gl.ondraw();
  };
  
  // Add mousewheel listener to the canvas
  $("#webglcanvas").mousewheel(mwheel);
  
  $("#gateLevel").slider({
    formatter: function(value) {
      return 'Showing >' + value + '% variants';
    }
  });
  
  $("#gateLevel").on('slideStop', function(e) {
    $("#gateVal").text(e.value);
    
    if ($("#dogating").prop('checked'))
      gl.ondraw();
  });
  
  $("#dodarkening").change(function() {
    updateLegend();
    gl.ondraw();
  });
  
  $("#dogating").change(function() {
    if (this.checked)
      $("#gateLevel").slider("enable");
    else
      $("#gateLevel").slider("disable");
      
    gl.ondraw();
  });
  
  
  $("#dodiagonal").change(gl.ondraw);
  $("#doconfidence").change(gl.ondraw);
  $("#dolightbinning").change(gl.ondraw);
  $("#useisoluminant").change(changeColormap);
  $("#fixwhitecenter").change(changeColormap);
  $("#usecolorbrewer").change(function() {
    $("input.bivariateOpts").prop("disabled", !this.checked);
    overviewToTexture();
    gl.ondraw();
  });
  
  $("#metrics").change(function() {
    var filename = $(this).val();
    
    // set the new equation image
    document.getElementById("metriceq").src = "img/" + filename + ".png";
    
    // check if this data has been loaded already
    if (!ds.ready[filename]) {
      updateLoadingStatus("loading metric " + filename + " ...");
      makeBinaryFileRequest(dataDir + filename, filename);
    }
    
    ds.curMetric = filename;
    gl.ondraw();
  });
  
  populateSuperZoom();
  
  useBivariate = true;
  changeColormap();
}
  
function initWebGLResources() {
  // if we're recovering from a lost context, invalidate any generated WebGL textures 
  // and buffers and force them to repopulate
  texturesCreated = false;
  
  // mark all metrics as 'not ready' to force reload them
  for (metric in ds.ready) {
    ds.ready[metric] = false;
  }

  // set up the viewport
  resizeCanvas();
  
  // load the shaders
  loadShaderFromFiles("points");
  loadShaderFromFiles("cb_points", "cb_points.vs", "points.fs");
  loadShaderFromFiles("pointsDiag", "pointsMatrix.vs", "points.fs");
  loadShaderFromFiles("cb_pointsDiag", "cb_pointsMatrix.vs", "points.fs");
  loadShaderFromFiles("cb_pointsDiagGated", "cb_pointsMatrixGated.vs", "points.fs");
  
  loadShaderFromFiles("overview");
  loadShaderFromFiles("fillOverview", "fillOverview.vs", "points.fs");
  loadShaderFromFiles("fillOverviewGated", "fillOverviewGated.vs", "points.fs");
  
  loadShaderFromFiles("solid");
  
  // debugging
  loadShaderFromFiles("texture", "texture.vs", "overview.fs");
  
  // gl.ondraw(); 
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
};

// `datasetObj` is an object with the fields `attenuation`, `metrics` (array of 
// metric files), `variantCounts` denoting data files.  
var loadDataset = function(datasetName, datasetObj) {
  updateLoadingStatus("loading dataset " + datasetName + " into view...");
  console.log("loading dataset " + datasetName + " into view");
  
  // do some REALLY rudimentary resetting of state 
  // (should WebGL buffers be explicitly deleted?)
  ds.numPos = 0;
  ds.numWindow = 0;
  texturesCreated = false;
  
  // mark all metrics as 'not ready' to force reload them
  for (metric in ds.ready) {
    ds.ready[metric] = false;
  }
  
  dataDir = "data/" + datasetName + "/";
  
  // make the requests for the primary metric and attenuation files
  makeBinaryFileRequest(dataDir + datasetObj['attenuation'], datasetObj['attenuation']);
  makeBinaryFileRequest(dataDir + datasetObj['metrics'][0], datasetObj['metrics'][0]);
  
  // make the request for the variantCount data (as shorts instead of floats)
  makeBinaryFileRequest(dataDir + datasetObj['variantCounts'], "varCounts"); 
  // loadExtraData();
  
  // load the metrics into the dropdown
  $("#metrics").html("");
  datasetObj['metrics'].forEach(function(d,i) {
    $("#metrics").append("<option>" + d +  "</option>");
  });
  
  // set the current display datasets
  ds.curAttenuation = datasetObj['attenuation'];
  ds.curMetric = datasetObj['metrics'][0];
  
  // finally, force the visualization to draw (will poll until data is ready)
  gl.ondraw();
};