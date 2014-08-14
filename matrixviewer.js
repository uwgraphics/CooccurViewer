var gl = GL.create();

window.onload = main;

var dataReady = false;
var timer = null;

var shaders = [];
var textures = [];
var plane;

var ds = {
  data: [],
  buf: 0,
  numWindow: 0,
  numPos: 0,
  maxVal: 0,
  name: ""
};

var screenOffset = [0, 0];
var scale = 1;
var offset = [0, 0];

var parseFile = function(text) {
  dataReady = false;
  
  var delimiter = ",";
  var lines = text.trim("\r").split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].split(delimiter);
  }
  
  ds.data = [];
  ds.numPos = lines.length;
  ds.numWindow = lines[0].length;
  ds.imgData = new Uint8Array(Math.min(8192, ds.numPos) * ds.numWindow * 4);
  
  for (var i = 0; i < lines.length; i++) {
    for (var j = 0; j < ds.numWindow; j++) {
      var curValue = +lines[i][j];
      
      // x,y position and z is the value
      var thisItem = [i, j, curValue];
      
      // keep track of the largest value we've seen so far
      ds.maxVal = Math.max(ds.maxVal, curValue);
      
      // push the point to the data stack
      ds.data.push(thisItem);
    }
  }
  
  // do another pass-through for the imgData array 
  // (truncate to 0-255 for Uint8 array; maxWidth is 8196, so avg)
  /*
  for (var i = 0; i < ds.data.length; i = i + 2) {
    if (i + 1 >= ds.data.length) {
      ds.imgData[(i / 2) * 4] = Math.floor(255 * (ds.data[i][2] / ds.maxVal));
    } else {
      ds.imgData[(i / 2) * 4] = 
        (
          Math.floor(255 * (ds.data[i][2] / ds.maxVal)) + 
          Math.floor(255 * (ds.data[i+1][2] / ds.maxVal))
        ) / 2;
    }
    
    // set alpha to 1 (necessary? could handle this in shader)
    ds.imgData[(i / 2) * 4 + 3] = 255;
  }
  */
  
  ds.bmpData = [];
  for (var i = 0; i < ds.numWindow; i++) {
    ds.bmpData.push([]);
  }
  
  
  for (var i = 0; i < ds.data.length; i = i + 1) {
    var imgIndex = ((i % ds.numWindow) * ds.numWindow) + Math.floor(i / ds.numWindow);
    //var imgIndex = i;
    
    if (imgIndex >= ds.numWindow * Math.min(8192, ds.numPos)) 
      continue;
    
    ds.imgData[imgIndex * 4] = Math.floor(255 * (ds.data[i][2] / ds.maxVal));
    ds.imgData[imgIndex * 4 + 1] = 0;
    ds.imgData[imgIndex * 4 + 2] = 0;
    ds.imgData[imgIndex * 4 + 3] = 255;
    
    ds.bmpData[i % ds.numWindow][Math.floor(i / ds.numWindow)] = 
      [Math.floor(255 * (ds.data[i][2] / ds.maxVal)), 0, 0];
    
  }  
  
  // compile the GPU data buffer
  ds.buf = new GL.Buffer(gl.ARRAY_BUFFER, Float32Array);
  ds.buf.data = ds.data;
  ds.buf.compile(gl.STATIC_DRAW);
  
  dataReady = true;
  
  debugImg();  
};

var debugImg = function() {
  var img = new Image();
  
  // would be nice to do the below, but it blows the stack.  do it iteratively instead
  // var base64data = btoa(String.fromCharCode.apply(null, ds.imgData));
  /*var base64data = "";
  for (var i = 0; i < ds.imgData.length; i++) {
    base64data += String.fromCharCode(ds.imgData[i]);
  }
  
  base64data = btoa(base64data);
  img.src = "data:image/png;base64," + base64data;*/
  
  // depends on imeplementation 
  // (see https://developer.mozilla.org/en-US/docs/Web/API/URL.createObjectURL)
  
  /*
  var thisURL = window.URL || window.webkitURL;
  
  var blob = new Blob([generateBitmapDataURL(ds.bmpData)], {'type': 'image/bmp'});
  img.src = thisURL.createObjectURL(blob);*/
  img.src = generateBitmapDataURL(ds.bmpData);
  img.width = 800;
  img.id = "bmpimg";
  /*img.onload = function(e) { 
    thisURL.revokeObjectURL(this.src);
  };*/
  
  document.getElementById("img-container").appendChild(img);
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
  gl.translate(screenOffset[0], screenOffset[1], 0);
  gl.scale(scale, scale, 1);
  gl.translate(offset[0], offset[1], 0);
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

var texturesCreated = false;
var createTextures = function() {

  var mipmapOpts = {
    magFilter: gl.LINEAR,
    minFilter: gl.NEAREST,
    format:    gl.RGBA,
    type:      gl.UNSIGNED_BYTE
  };
  
  var pot_width  = Math.min(8192, Math.pow(2, Math.ceil(Math.log(ds.numPos) / Math.log(2))));
  var pot_height = Math.min(8192, Math.pow(2, Math.ceil(Math.log(ds.numWindow) / Math.log(2))));
  
  // gotta make the texture from 'scratch'
  textures['full'] = new GL.Texture(pot_width, pot_height, mipmapOpts);
  //gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  
  var width = Math.min(8192, ds.numPos);
  var height = Math.min(8192, ds.numWindow);
  console.log("texture height: " + pot_height + ", width: " + pot_width);
  console.log("renderTo: height: " + height + ", width: " + width);
  
  // try rendering from an image
  textures['full'] = GL.Texture.fromImage(document.getElementById("bmpimg"), mipmapOpts);
  
  /*
  
//  gl.bindTexture(gl.TEXTURE_2D, textures.full.id);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(8192, ds.numPos), ds.numWindow, textures['full'].format, textures['full'].type, ds.imgData);
  //gl.texImage2D(gl.TEXTURE_2D, 0, textures.full.format, Math.min(8192, ds.numPos), 
  //  ds.numWindow, 0, textures.full.format, textures.full.type, ds.imgData);
  gl.generateMipmap(gl.TEXTURE_2D);
  */
  
  // clean up state
  gl.bindTexture(gl.TEXTURE_2D, null);
};

gl.ondraw = function() {
  if (!dataReady || !shaders['points'] || !shaders['overview']) {
    //if (!timer) {
      timer = setTimeout("gl.ondraw()", 300);
    //}
    return;
  }
  
  if (!texturesCreated) {
    createTextures();
  }
  
  gl.clearColor(1.0, 1.0, 1.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  
  // fix plane to the dimensions of the large ds.imgData texture
  plane = new GL.Mesh.plane();
  
  y_min = 1 - ((textures['full'].height / textures['full'].width) * 2);
  plane.vertices[0][1] = y_min;
  plane.vertices[1][1] = y_min;
  
  /*
  plane.vertices[0][1] = 0;
  plane.vertices[1][1] = 0;
  plane.vertices[1][0] = textures.full.width / textures.full.height;
  plane.vertices[3][0] = textures.full.width / textures.full.height;*/
  
  plane.compile();
  
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  
  
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  

  gl.pushMatrix();
  gl.matrixMode(gl.MODELVIEW);
  setZoomPan();
  
  var vertBuffer = [];
  vertBuffer['position'] = ds.buf;
  shaders['points'].uniforms({
    pointSize: 1,
    maxVal: ds.maxVal
  }).drawBuffers(vertBuffer, null, gl.POINTS);
  
  gl.popMatrix();
  
  textures['full'].bind(0);
  shaders['overview'].uniforms({
    texture: 0,
    minVal: y_min
  }).draw(plane);
  textures['full'].unbind(0);  
}

var resizeCanvas = function() {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.matrixMode(gl.PROJECTION);
  gl.loadIdentity();
  gl.ortho(0, gl.canvas.width, 0, gl.canvas.height, -100, 100);
  gl.matrixMode(gl.MODELVIEW);
}

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
  
  loadShaderFromFiles("points");
  loadShaderFromFiles("overview");
  
  $.get("readBreadthMed.csv", parseFile);
  
  gl.ondraw();
};