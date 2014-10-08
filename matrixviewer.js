var gl = GL.create({width: 800, height: 800});

// colobrewer.RdBu['11'] set to luminance 65 (tol: 5)
// http://graphics.cs.wisc.edu/Projects/RampGen/build_ramps.html
var isoluminantRdBu = ["#EC7B8B", "#FF696B", "#F07C68", "#D38D6D", "#B59887", "#9E9E9E", "#8FA0AA", "#75A4BB", "#59A6D4", "#68A0E8", "#829ED9"];
var isoluminantRdBuFixedWhite = ["#EC7B8B", "#FF696B", "#F07C68", "#D38D6D", "#B59887", "#FFFFFF", "#8FA0AA", "#75A4BB", "#59A6D4", "#68A0E8", "#829ED9"];

window.onload = main;

var dataReady = false;
var dataBreadthReady = true;
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

var ds = {
  data: [],
  depth: [],
  buf: 0,
  numWindow: 0,
  numPos: 0,
  minVal: 1000,
  maxVal: -1000,
  maxDepth: 0,
  name: ""
};

var screenOffset = [0, 0];
var scale = 1;
var offset = [0, 0];

var parseFile = function(text, binary) {
  console.time("parsing file");
  dataReady = false;
  
  if (binary) {
    console.time("reading binary data");
    
    // assumes text is of type 'arraybuffer'
    var dv = new DataView(text);
    
    // format of the file is windowSize (int), numPositions (int), then data
    ds.numWindow = dv.getInt32(0);
    ds.numPos = dv.getInt32(4);
    
    console.log("Found %d positions with %d window size", ds.numPos, ds.numWindow);
    console.log("Number of elements found: %d, expected %d", (dv.byteLength - 8) / 4, ds.numPos * ds.numWindow);
    
    ds.data = new Float32Array(ds.numPos * ds.numWindow * 4);
    var numFloats = ds.numPos * ds.numWindow;
    for (var i = 0, offset = 8; i < ds.numPos; i++) {
      for (var j = 0; j < ds.numWindow; j++, offset += 4) {
        var curValue = dv.getFloat32(offset);
        
        var curIndex = (i * ds.numWindow + j) * 4
        ds.data[curIndex] = i;
        ds.data[curIndex + 1] = j;
        ds.data[curIndex + 2] = curValue;
        
        ds.maxVal = Math.max(ds.maxVal, curValue);
        ds.minVal = Math.min(ds.minVal, curValue);
      }
    }
    
    console.timeEnd("reading binary data");
    
  } else { // assume default is csv  
    console.time("chunking data");
    var delimiter = ",";
    var lines = text.trim("\r").split("\n");
    for (var i = 0; i < lines.length; i++) {
      lines[i] = lines[i].split(delimiter);
    }
    
    ds.numPos = lines.length;
    ds.numWindow = lines[0].length;
    ds.data = new Float32Array(ds.numPos * ds.numWindow * 4);
    
    for (var i = 0; i < ds.numPos; i++) {
      for (var j = 0; j < ds.numWindow; j++) {
        var curValue = +lines[i][j];
        
        // x,y position and z is the value
        //var thisItem = [i, j, curValue];
        var curIndex = (i * ds.numWindow + j) * 4
        ds.data[curIndex] = i;
        ds.data[curIndex + 1] = j;
        ds.data[curIndex + 2] = curValue;
        
        // keep track of the largest/smallest value we've seen so far
        ds.maxVal = Math.max(ds.maxVal, curValue);
        ds.minVal = Math.min(ds.minVal, curValue);
        
        // push the point to the data stack
        //ds.data.push(thisItem);
      }
    }
    console.timeEnd("chunking data");
  }
  
  // cheap flag to see whether we should load readBreadth data as well
  if (useBivariate) {
    $.get("readBreadthAll.csv", parseReadDepth);
  } else {
    console.time("sending data to GPU");
    
    // compile the GPU data buffer
    ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
    ds.buf.buffer = gl.createBuffer();
    ds.buf.buffer.length = ds.numPos * ds.numWindow * 4;
    ds.buf.buffer.spacing = 4;
    
    gl.bindBuffer(ds.buf.target, ds.buf.buffer);
    gl.bufferData(ds.buf.target, ds.data, gl.STATIC_DRAW);
    
    console.timeEnd("sending data to GPU");
    dataReady = true;
  }
  
  console.timeEnd("parsing file");
};

// adds read depth information to the data parsed
var parseReadDepth = function(text) {
  if (!text) {
    console.warn("no text found for parseReadDepth().");
    return;
  }
  
  console.time("parsing read depth file");
  
  console.time("chunking data");
  var delimiter = ",";
  var lines = text.trim("\r").split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].split(delimiter);
  }
  
  // do some range checks to make sure we're looking at the same original data (same window size, numPositions)
  if (ds.numPos != lines.length) {
    console.warn("number of lines in depth does not match data: expected %d, depth had %d lines", ds.numPos, lines.length);
  } 
  
  if (ds.numWindow != lines[0].length) {
    console.warn("number of items in a window does not match data: expected %d, depth had a window size of %d", ds.numWindow, lines[0].length);
  }
  
  // if the window and positions don't line up, align the positions to the start
  // and center align the window.
  var windowOffset = (ds.numWindow - lines[0].length) / 2;
  var numPositions = Math.min(lines.length, ds.numPos);
  for (var i = 0; i < numPositions; i++) {
    for (var j = windowOffset; j < ds.numWindow - windowOffset; j++) {
      var curValue = +lines[i][j - windowOffset];
      var curIndex = (i * ds.numWindow + j) * 4 + 3;
      
      ds.data[curIndex] = curValue;
      ds.maxDepth = Math.max(ds.maxDepth, curValue);      
    }
  }  
  
  console.timeEnd("parsing read depth file");
  
  console.time("sending data to GPU");
  
  // compile the GPU data buffer
  ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buf.buffer = gl.createBuffer();
  ds.buf.buffer.length = ds.numPos * ds.numWindow * 4;
  ds.buf.buffer.spacing = 4;
  
  gl.bindBuffer(ds.buf.target, ds.buf.buffer);
  gl.bufferData(ds.buf.target, ds.data, gl.STATIC_DRAW);
  
  console.timeEnd("sending data to GPU");
  
  dataReady = true;
};

// construct a bitmap image using `bitmap.js`.
// used as a debugging tool, but also creates the bitmap to load into the texture
var debugImg = function() {
  var img = new Image();
  
  img.src = generateBitmapDataURL(ds.bmpData);
  img.width = 800;
  img.id = "bmpimg";
  document.getElementById("img-container").appendChild(img);
};

var debugPoint = function(x, y) {
  var wIndex = x - y + Math.floor(ds.numWindow / 2);
  
  // throw an error if the corresponding y value falls outside the loaded window
  if (wIndex < 0 || wIndex >= ds.numWindow) {
    // console.log("tried to access out of bounds value, (%d, %d)", x, y);
    return false;
  }
  
  console.log("got wIndex: %d", wIndex);
  
  var curIndex = (y * ds.numWindow + wIndex) * 4;
  
  return [ds.data[curIndex], ds.data[curIndex + 1], ds.data[curIndex + 2], ds.data[curIndex + 3]];
};

/*
var updateColormapChoice = function() {
  //chosenColormap = useBivariate ? colorbrewer.RdBu['11'] : colorbrewer.OrRd['9'];
  chosenColormap = useBivariate ? isoluminantRdBu : colorbrewer.OrRd['9'];
};*/

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

// given an absolute position x, y (e.g. the actual positions of x and y; y is NOT
// an index into the window), return the value from the data
var getDataValueFromAbsolutePosition = function(x, y) {
  // have to convert from absolute y to a window index;
  // y = x corresponds to Math.floor(ds.numWindow / 2)
  var wIndex = x - y + Math.floor(ds.numWindow / 2);
  
  // throw an error if the corresponding y value falls outside the loaded window
  if (wIndex < 0 || wIndex >= ds.numWindow) {
    // console.log("tried to access out of bounds value, (%d, %d)", x, y);
    return false;
  }
  
  return ds.data[(y * ds.numWindow + wIndex) * 4 + 2];
};

// given a x position (position number) and a y value (window value),
// get the color that represents this value
var getColorForPosition = function(x, y) {
  var curIndex = (x * ds.numWindow + y) * 4 + 2;
  
  var data = ds.data[curIndex];
  
  return getColorFromDataValue(data);  
}

// given a particular value, return the color [r,g,b,a]
// that represents this value
var getColorFromDataValue = function(value) {
  var arr = [];
  
  if ($("#usecolorbrewer").prop('checked')) {
    // clamp min and max to lowest and highest ramp positions, respectively.
    var cbIndex = 0;
    if (value <= ds.minVal)
      cbIndex = 0;
    else if (value >= ds.maxVal)
      cbIndex = chosenColormap.length - 1;
    else if (value == 0 && useBivariate) {
      cbIndex = Math.floor(chosenColormap.length / 2);
      //console.log("mid value");
    } else
      cbIndex = Math.floor((value - ds.minVal) / (ds.maxVal - ds.minVal) * (chosenColormap.length - 2)) + 1;
    
    // the stride is 4!
    cbIndex *= 4;
      
    arr = [colormapRGBA[cbIndex], colormapRGBA[cbIndex + 1], colormapRGBA[cbIndex + 2], 255];
    
  } else {
    arr = [value / ds.maxVal * 255, 0, 0, 255];
  }
  
  return arr;
};

// take ds.data and turn it into a texture
var overviewToTexture = function() {
  console.time("constructing overview texture using CPU");
  
  // if the texture already exists, use it
  var curTexture = $("#usecolorbrewer").prop('checked') ? "lightOver" : "colorOver";
  if (textures[curTexture]) {
    return;
  }
 
  var texWidth = ds.numPos;
  var arr;
  var maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  // arrange the data as appropriate
  if (ds.numPos < maxTexSize) {
    arr = new Uint8Array(ds.numPos * ds.numWindow * 4)
    
    for (var x = 0; x < ds.numPos; x++) {
      for (var y = 0; y < ds.numWindow; y++) {
        var curVal = getColorForPosition(x, y);
        var curIndex = (y * ds.numPos + x) * 4;
        
        for (var n = 0; n < 4; n++) {
          arr[curIndex + n] = curVal[n];
        }
      }
    }
  } else {
    var numPixelsToCollapse = Math.ceil(ds.numPos / maxTexSize);
    texWidth = Math.ceil(ds.numPos / numPixelsToCollapse);
    
    arr = new Uint8Array(texWidth * ds.numWindow * 4);
    
    for (var y = 0; y < ds.numWindow; y++) {
      for (var x = 0; x < texWidth; x++) {
        var numPixels = numPixelsToCollapse;
        var sumPixels = 0;
        
        for (var n = 0; n < numPixelsToCollapse; n++) {
          var curIndex = ((x * numPixelsToCollapse) + n) * ds.numWindow + y;
          
          if (curIndex < ds.numPos * ds.numWindow) {
            sumPixels += ds.data[curIndex * 4 + 2];
          } else {
            numPixels--;
          }
        }
        
        var destIndex = (y * texWidth + x) * 4;
        if (numPixels <= 0) {
          arr[destIndex + 3] = 255;
          continue;
        } 
        
        var curVal = getColorFromDataValue(sumPixels / numPixels);
        for (var n = 0; n < 4; n++) {
          arr[destIndex + n] = curVal[n];
        }
      }
    }
  }

  // create the texture, if it doesn't exist
  textures[curTexture] = new GL.Texture(texWidth, ds.numWindow);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  
  textures[curTexture].bind(0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texWidth, ds.numWindow, 0, gl.RGBA, gl.UNSIGNED_BYTE, arr);
  textures[curTexture].unbind(0);
  
  console.timeEnd("constructing overview texture using CPU");
};

// TODO: shader doesn't support non-colorbrewer coloring mode
var constructOverviewTexture = function() {
  console.time("constructing overview texture using WebGL drawing");
  
  // if the texture already exists, use it
  var curTexture = $("#usecolorbrewer").prop('checked') ? "lightOver" : "colorOver";
  
  // TODO
  if (!$("#usecolorbrewer").prop('checked')) {
    console.error("fillOverview shader does not support non-colorbrewer drawing");
    return;
  }
  
  if (!textures[curTexture]) {
    var texHeight = gl.canvas.width * ds.numWindow / ds.numPos
    textures[curTexture] = new GL.Texture(gl.canvas.width, texHeight);
  }
  
  textures[curTexture].drawTo(function() {
    var bivar = useBivariate ? 1 : 0;
    var darken = $("#dodarkening").prop('checked') ? 1 : 0;
    
    if (darken)
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
    else
      gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    var vertBuffer = [];
    vertBuffer['position'] = ds.buf; 
    colormapTexture.bind(0);
    
    shaders['fillOverview'].uniforms({
      dataSize: [ds.numPos, ds.numWindow],
      minVal: ds.minVal,
      maxVal: ds.maxVal,
      maxDepth: ds.maxDepth,
      bivariate: bivar,
      darkening: darken,
      rampTexWidth: colormapWidth,
      numSteps: chosenColormap.length,
      colorRamp: 0
    }).drawBuffers(vertBuffer, null, gl.POINTS);
    
    colormapTexture.unbind(0);
  });
  
  // compute how many y-pixels the overview + indicator takes up
  topMargin = Math.floor((ds.numWindow / ds.numPos) * gl.canvas.width) + indicatorHeight + 1;
  updateAxisLabels();
  
  console.timeEnd("constructing overview texture using WebGL drawing");
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
    gl.scale(1, -1, 1);    
    gl.translate(screenOffset[0], screenOffset[0] - gl.canvas.height + topMargin, 0);
    // gl.translate(-55, -55, 0);
  } else {
    gl.translate(screenOffset[0], screenOffset[1], 0);
    gl.scale(1, 1, 1);
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
  
  // try rendering from an image
  //textures['full'] = GL.Texture.fromImage(document.getElementById("bmpimg"), defaultOpts);
  //overviewToTexture();
  //constructOverviewTexture();
  
  // fix plane to the dimensions of the large ds.imgData texture
  overview = new GL.Mesh.plane();
  
  y_min = 1 - ((ds.numWindow / ds.numPos) * 2);
  //y_min = 1 - ((textures['full'].height / textures['full'].width) * 2);
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
  indicatorWidth = $("#dodiagonal").prop('checked') ? 2 * (gl.canvas.height - indicatorHeight) / ds.numPos : 2 * (gl.canvas.width / ds.numPos);
  
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
  var cbPtShader = $("#dodiagonal").prop('checked') ? shaders['cb_pointsDiag'] : shaders['cb_points'];

  if (!dataReady || !dataBreadthReady || !ptShader || !cbPtShader || 
      !shaders['overview'] || !shaders['solid'] || !shaders['fillOverview']) 
  {
    timer = setTimeout("gl.ondraw()", 300);
    return;
  }
  
  if (!texturesCreated) {
    createTextures();
  }
  
  constructOverviewTexture();
  
  console.time("gl.ondraw()");
  
  // based on screenOffset, update the overview indicator
  updateIndicator();
  
  gl.clearColor(0.0, 0.0, 0.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  
  // get ready to draw the full-detailed matrix diagonal
  gl.pushMatrix();
  gl.matrixMode(gl.MODELVIEW);
  setZoomPan(); // unused right now...
  
  var vertBuffer = [];
  vertBuffer['position'] = ds.buf; 
  if ($("#usecolorbrewer").prop('checked')) {
    colormapTexture.bind(0);
    var bivar = useBivariate ? 1 : 0;
    var darken = $("#dodarkening").prop('checked') ? 1 : 0;
    var confid = $("#doconfidence").prop('checked') ? 1 : 0;
    var binL = $("#dolightbinning").prop('checked') ? 1 : 0;
    cbPtShader.uniforms({
      pointSize: 1,
      windowSize: ds.numWindow,
      maxVal: ds.maxVal,
      minVal: ds.minVal,
      maxDepth: ds.maxDepth,
      bivariate: bivar,
      darkening: darken,
      confidence: confid,
      binLight: binL,
      rampTexWidth: colormapWidth,
      numSteps: chosenColormap.length,
      colorRamp: 0
    }).drawBuffers(vertBuffer, null, gl.POINTS);
    colormapTexture.unbind(0);
  } else {
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
  var xmax = Math.floor(-screenOffset[0] + gl.canvas.width);
  
  $("#label-xmin").html(spacify(xmin));
  $("#label-xmax").html(spacify(xmax));
  if ($("#dodiagonal").prop('checked')) {
    var ymin = xmin;
    var ymax = ymin + gl.canvas.height - topMargin;
    
    $("#label-ymin").html(spacify(ymin));
    $("#label-ymax").html(spacify(ymax));
  } else {
    console.warn("axis labels not implemented for non-diagonal representations");
  }
};

var populateSuperZoom = function() {
  var sZContainer = document.getElementById("super-zoom");
  var colors = colorbrewer.Pastel1['9'];
  for (var i = 0; i < 9; i++) {
    var newPixel = document.createElement("div");
    newPixel.className = "pixel" + i;
    newPixel.style.backgroundColor = colors[i];
    sZContainer.appendChild(newPixel);
    
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
  var dataCoords = convertScreenToDataCoords();
  
  var sZContainer = document.getElementById("super-zoom");
  for (var i = 0; i < 9; i++) {
    var curPixel = sZContainer.children[i];
    
    var dx = (i % 3) - 1;
    var dy = Math.floor(i / 3) - 1;
    
    var x = dataCoords[0] + dx;
    var y = dataCoords[1] + dy;
    
    var curVal = getDataValueFromAbsolutePosition(x, y);
    
    if (curVal === false) {
      curPixel.style.backgroundColor = "#000";
      curPixel.children[1].innerHTML = "";
      curPixel.children[0].innerHTML = "--";
    } else {
      var c = getColorFromDataValue(curVal);
      curPixel.style.backgroundColor = "rgb("+c[0]+","+c[1]+","+c[2]+")";
      curPixel.children[1].innerHTML = "("+x+", "+y+")";
      curPixel.children[0].innerHTML = curVal.toFixed(3);
    }
  }
};

// translate from panX, panY to data coordinates; what data is our mouse over?
var convertScreenToDataCoords = function() {
  // figure out how tall the overview is
  //var topMargin = Math.floor((ds.numWindow / ds.numPos) * gl.canvas.width) + indicatorHeight + 1;
  
  var xval, yval;
  if ($("#dodiagonal").prop('checked')) {
    var xmin = Math.floor(-screenOffset[0]);
    var ymin = xmin;
    
    xval = panX + xmin;
    yval = (gl.canvas.height - panY) - topMargin + ymin;
  } else { // TODO: implement
    xval = -1;
    yval = -1;
  }
  
  return [xval, yval];
};

// update legend with the current colorramp (uses D3.js)
var updateLegend = function() {
  // the data we're using is the 'chosenColormap'; assume it's been populated by this point
  
  var svgWidth = 200, svgHeight = 200;
  var svg = d3.select("#legend").attr('width', svgWidth).attr('height', svgHeight);
  
  var margin = 2;
  var effWidth = svgWidth - margin;
  var effHeight = svgHeight - margin;
  
  var numLightBins = 11;  
  var scales = [];
      
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
  } else {
    e.preventDefault();
    // updateSuperZoom();
  }
};

gl.onmousemove = function(e) {
  panX = e.x;
  panY = gl.canvas.height - e.y;
  
  if (drags(e)) {    
    //setCleanXInput(panX);
    //gl.ondraw();
  } else if (dataReady && $("#dodiagonal").prop('checked')) {
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

function main() {
  gl.canvas.id = "webglcanvas";
  document.getElementById("canvas-container").appendChild(gl.canvas);
  
  // set up the viewport
  resizeCanvas();
  
  // load the shaders
  loadShaderFromFiles("points");
  loadShaderFromFiles("cb_points", "cb_points.vs", "points.fs");
  loadShaderFromFiles("pointsDiag", "pointsMatrix.vs", "points.fs");
  loadShaderFromFiles("cb_pointsDiag", "cb_pointsMatrix.vs", "points.fs");
  
  loadShaderFromFiles("overview");
  loadShaderFromFiles("fillOverview", "fillOverview.vs", "points.fs");
  
  loadShaderFromFiles("solid");
  
  // debugging
  loadShaderFromFiles("texture", "texture.vs", "overview.fs");
  
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
  
  $("#dodiagonal").change(gl.ondraw);
  
  $("#dodarkening").change(function() {
    updateLegend();
    gl.ondraw();
  });
  
  $("#doconfidence").change(gl.ondraw);
  $("#dolightbinning").change(gl.ondraw);
  $("#useisoluminant").change(changeColormap);
  $("#fixwhitecenter").change(changeColormap);
  $("#usecolorbrewer").change(function() {
    $("input.bivariateOpts").prop("disabled", !this.checked);
    overviewToTexture();
    gl.ondraw();
  });

  if (location.search == "?reads") {
    useBivariate = false;
    $.get("readBreadthAll.csv", function(data) { parseFile(data); });
  } else if (location.search == "?expected") {
    // jQuery looks too hard here; it's not implemented yet for ArrayBuffer 
    // xhr requests, which is an HTML5 phenomenon:
    // http://www.artandlogic.com/blog/2013/11/jquery-ajax-blobs-and-array-buffers/
    var xhr = new XMLHttpRequest();
    xhr.open('GET', "conjProbDiff.dat", true);
    xhr.responseType = 'arraybuffer';
    
    xhr.addEventListener('load', function() {
      if (xhr.status == 200) {
        parseFile(xhr.response, true);
      } else {
        console.warning("failed to load requested file (status: %d)", xhr.status);
        console.trace();
      }
    });
    
    useBivariate = true;
    xhr.send(null);
  } else {
    useBivariate = false;
    $.get("conjProb.csv", function(data) { parseFile(data); });
  }
  
  populateSuperZoom();
  
  changeColormap();
  gl.ondraw();
};
