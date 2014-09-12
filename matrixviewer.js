var gl = GL.create({width: 800, height: 800});

window.onload = main;

var dataReady = false;
var timer = null;

var shaders = [];
var textures = [];
var overview, indicator, indicatorBackground;
var indicatorWidth = 0;
var indicatorHeight = 4;

var useBivariate = false;
var chosenColormap;
var colormapRGBA;
var colormapTexture;
var colormapWidth = 0;

var ds = {
  data: [],
  buf: 0,
  numWindow: 0,
  numPos: 0,
  minVal: 1000,
  maxVal: -1000,
  name: ""
};

var screenOffset = [0, 0];
var scale = 1;
var offset = [0, 0];

var parseFile = function(text) {
  console.time("parsing file");
  dataReady = false;
  
  
  console.time("chunking data");
  var delimiter = ",";
  var lines = text.trim("\r").split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].split(delimiter);
  }
  
  ds.numPos = lines.length;
  ds.numWindow = lines[0].length;
  ds.data = new Float32Array(ds.numPos * ds.numWindow * 3);
  
  for (var i = 0; i < ds.numPos; i++) {
    for (var j = 0; j < ds.numWindow; j++) {
      var curValue = +lines[i][j];
      
      // x,y position and z is the value
      //var thisItem = [i, j, curValue];
      var curIndex = (i * ds.numWindow + j) * 3
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
  
  console.time("sending data to GPU");
  
  // compile the GPU data buffer
  ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buf.buffer = gl.createBuffer();
  ds.buf.buffer.length = ds.numPos * ds.numWindow * 3;
  ds.buf.buffer.spacing = 3;
  
  gl.bindBuffer(ds.buf.target, ds.buf.buffer);
  gl.bufferData(ds.buf.target, ds.data, gl.STATIC_DRAW);
  
  console.timeEnd("sending data to GPU");
  
  dataReady = true;
  console.timeEnd("parsing file");
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

var updateColormapChoice = function() {
  chosenColormap = useBivariate ? colorbrewer.RdBu['11'] : colorbrewer.OrRd['9'];
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
var colorbrewerRampToTexture = function(colors) {
  var w = Math.ceil(Math.sqrt(colors.length));
  colormapTexture = new GL.Texture(w, w, {filter: gl.NEAREST, wrap: gl.CLAMP_TO_EDGE});
  
  // Unset variable set by lightgl.js in TEXTURE.js;
  // see <http://code.google.com/p/chromium/issues/detail?id=125481>
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  
  colormapRGBA = colorbrewerRampToBuffer(colors, w);  
  
  colormapTexture.bind(0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, w, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapRGBA);
  colormapTexture.unbind(0);

  colormapWidth = w;
};

// given a x position (position number) and a y value (window value),
// get the color that represents this value
var getColorForPosition = function(x, y) {
  var curIndex = (x * ds.numWindow + y) * 3 + 3;
  
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
    if (value <= ds.minVal && !useBivariate)
      cbIndex = 0;
    else if (value >= ds.maxVal && !useBivariate)
      cbIndex = chosenColormap.length - 1;
    else if (value == 0 && useBivariate) {
      cbIndex = Math.floor(chosenColormap.length / 2);
      //console.log("mid value");
    } else
      cbIndex = Math.floor((value - ds.minVal) / (ds.maxVal - ds.minVal) * (chosenColormap.length - 2));
    
    // the stride is 4!
    cbIndex *= 4;
      
    arr = [colormapRGBA[cbIndex], colormapRGBA[cbIndex + 1], colormapRGBA[cbIndex + 2]];
    
  } else {
    arr = [value / ds.maxVal * 255, 0, 0, 255];
  }
  
  return arr;
};

// take ds.data and turn it into a texture
var overviewToTexture = function() {
  console.time("constructing overview texture");
  
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
            sumPixels += ds.data[curIndex * 3 + 2];
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
  
  console.timeEnd("constructing overview texture");
};

var setInitBounds = function() {
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
    var topMargin = (ds.numWindow / ds.numPos) * gl.canvas.width + indicatorHeight + 1;
    gl.translate(0, gl.canvas.height - topMargin - 2*screenOffset[0], 0);
    gl.translate(screenOffset[0], screenOffset[0], 0);
    gl.scale(scale, -scale, 1);
    gl.translate(offset[0], offset[1], 0);
  } else {
    gl.translate(screenOffset[0], screenOffset[1], 0);
    gl.scale(scale, scale, 1);
    gl.translate(offset[0], offset[1], 0);
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
  overviewToTexture();
  
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

  if (!dataReady || !ptShader || !cbPtShader || 
      !shaders['overview'] || !shaders['solid']) 
  {
    timer = setTimeout("gl.ondraw()", 300);
    return;
  }
  
  if (!texturesCreated) {
    createTextures();
  }
  
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
    cbPtShader.uniforms({
      pointSize: 1,
      windowSize: ds.numWindow,
      maxVal: ds.maxVal,
      minVal: 0,
      bivariate: bivar,
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

// ## Handlers for mouse-interaction
// Handle panning the canvas.
var panX, panY;
var buttons = {};
gl.onmousedown = function(e) {
  buttons[e.which] = true;
  panX = e.x;
  panY = gl.canvas.height - e.y;
  
  setCleanXInput(panX);
  gl.ondraw();
};


gl.onmousemove = function(e) {
  if (drags(e)) {    
    panX = e.x;
    panY = gl.canvas.height - e.y;
    
    setCleanXInput(panX);
    gl.ondraw();
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

function main() {
  gl.canvas.id = "webglcanvas";
  document.getElementById("canvas-container").appendChild(gl.canvas);
  
  // set up the viewport
  resizeCanvas();
  
  // Function to handle asynchronous loading and compilation of shaders.
  var loadShaderFromFiles = function(name, opt_vn, opt_fn) {
    var vn = opt_vn || name + '.vs';
    var fn = opt_fn || name + '.fs';
    var shaderDir = 'shaders/';
    var vd, fd;
    $.get(shaderDir + vn, function(data) {
      vd = data;
      if (fd)
        shaders[name] = new GL.Shader(vd, fd);
    });
    $.get(shaderDir + fn, function(data) {
      fd = data;
      if (vd)
        shaders[name] = new GL.Shader(vd, fd);
    });
  };
  
  $("#dodiagonal").change(gl.ondraw);
  $("#usecolorbrewer").change(function() {
    overviewToTexture();
    gl.ondraw();
  });
  
  loadShaderFromFiles("points");
  loadShaderFromFiles("cb_points", "cb_points.vs", "points.fs");
  loadShaderFromFiles("pointsDiag", "pointsMatrix.vs", "points.fs");
  loadShaderFromFiles("cb_pointsDiag", "cb_pointsMatrix.vs", "points.fs");
  loadShaderFromFiles("overview");
  loadShaderFromFiles("solid");
  
  // debugging
  loadShaderFromFiles("texture", "texture.vs", "overview.fs");
  
  if (location.search == "?reads") {
    useBivariate = false;
    $.get("readBreadthAll.csv", parseFile);
  } else if (location.search == "?expected") {
    useBivariate = true;
    $.get("conjProbDiff.csv", parseFile);
  } else {
    useBivariate = false;
    $.get("conjProb.csv", parseFile);
  }
  
  updateColormapChoice();
  gl.ondraw();
};