uniform vec2 dataSize;

uniform float minVal;
uniform float maxVal;
uniform float maxDepth;

uniform int bivariate;
uniform int darkening;

uniform float rampTexWidth;
uniform float numSteps;
uniform sampler2D colorRamp;

attribute vec4 position;

varying vec4 vColor;

float f(float n, float eps, float k){
    if(n > eps){
		return pow(n, 1.0/3.0);
	}else{
	    return (k * n + 16.0) / 116.0;
	}    
}
vec3 XYZtoLRGB(vec3 xyz, bool clamp){
	vec3 M0 = vec3( 3.2404542, -1.5371385, -0.4985314);
	vec3 M1 = vec3(-0.9692660,  1.8760108,  0.0415560);
	vec3 M2 = vec3( 0.0556434, -0.2040259,  1.0572252);

    float r = dot(xyz, M0);
    float g = dot(xyz, M1);
    float b = dot(xyz, M2);

    if(clamp){
        r = min(max(r, 0.0), 1.0);
        g = min(max(g, 0.0), 1.0);
        b = min(max(b, 0.0), 1.0);
    }
		
	return vec3(r,g,b);
}
vec3 LRGBtoXYZ(vec3 lrgb){
	vec3 M0 = vec3(0.4124564, 0.3575761, 0.1804375);
	vec3 M1 = vec3(0.2126729, 0.7151522, 0.0721750);
	vec3 M2 = vec3(0.0193339, 0.1191920, 0.9503041);
		  
	return  vec3(dot(lrgb, M0), dot(lrgb, M1), dot(lrgb, M2));
}
vec3 XYZtoLAB(vec3 xyz){
	float Xr = 0.95047;
    float Yr = 1.0;
	float Zr = 1.08883;

	float eps = 216.0 / 24389.0;
	float k = 24389.0 / 27.0;
		  
	float xr = xyz.x / Xr;
	float yr = xyz.y / Yr;
	float zr = xyz.z / Zr;

	xr = f(xr, eps, k);
	yr = f(yr, eps, k);
	zr = f(zr, eps, k);

	float L = 116.0 * yr - 16.0;
	float a = 500.0 * (xr - yr);
	float b = 200.0 * (yr - zr);

	return vec3(L,a,b);
}
vec3 LABtoXYZ(vec3 lab){
	float Xr = 0.95047;
	float Yr = 1.0;
	float Zr = 1.08883;
		
	float eps = 216.0 / 24389.0;
	float k = 24389.0 / 27.0;

	float L = lab.x;
	float a = lab.y;
	float b = lab.z;

	float fy  = (L + 16.0) / 116.0;
	float fx  = a / 500.0 + fy;
	float fz  = -b / 200.0 + fy;

	float xr = ((pow(fx, 3.0) > eps) ? pow(fx, 3.0) : (116.0 * fx - 16.0) / k);
	float yr = ((L > (k * eps)) ? pow(((L + 16.0) / 116.0), 3.0) : L / k);
	float zr = ((pow(fz, 3.0) > eps) ? pow(fz, 3.0) : (116.0 * fz - 16.0) / k);

	float X = xr * Xr;
	float Y = yr * Yr;
	float Z = zr * Zr;

	return vec3(X,Y,Z);
}
vec3 LABtoLCH(vec3 lab){
	float l = lab.x;
	float a = lab.y;
	float b = lab.z;
		
	float C = sqrt(a*a + b*b);
	float H = atan(b,a);

    return vec3(l,C,H);
}
vec3 LCHtoLAB(vec3 lch){
	float l = lch.x;
	float c = lch.y;
	float h = lch.z;
		
	return vec3(l, c*cos(h), c*sin(h));
}
vec3 RGBtoLAB(vec3 rgb){
	return  XYZtoLAB(LRGBtoXYZ(rgb));
}
vec3 LABtoRGB(vec3 lab, bool clamp){
	return XYZtoLRGB(LABtoXYZ(lab), clamp);
}

vec4 getColorFromColorRamp() {
	// figure out where in the ramp we are 
	float cbIndex = 0.0;
	if (position.z <= minVal && bivariate == 0) {
		cbIndex = 0.0;
	} else if (position.z >= maxVal && bivariate == 0) {
		cbIndex = numSteps - 1.0;
	} else if (position.z == 0.0 && bivariate == 1) {
		cbIndex = floor(numSteps / 2.0);
	} else {
		cbIndex = floor(((position.z - minVal) / (maxVal - minVal)) * (numSteps - 2.0)) + 1.0;
	}
	
	// get the color from the texture (clamp to range [0,1])
	float yCoord = floor(cbIndex / rampTexWidth) / rampTexWidth;
	float xCoord = floor(mod(cbIndex, rampTexWidth)) / rampTexWidth;
	
	if (bivariate == 0) {
		return texture2D(colorRamp, vec2(xCoord, yCoord) + vec2(0.03));
	} else {	
		// try changing the luminance only
		float dimFactor = position.w / maxDepth;
		vec3 labColor = LABtoLCH(RGBtoLAB(texture2D(colorRamp, vec2(xCoord, yCoord) + vec2(0.03)).rgb));
		
		// darkening (works)
		if (darkening == 1) {
			labColor.x = labColor.x * dimFactor;
		} else {
			labColor = mix(labColor, vec3(100.0, 0.0, 0.0), 1.0 - dimFactor);
		}
		
		if (false) {
			labColor.y = labColor.y * pow(1.0, dimFactor);
		}
		
		return vec4(LABtoRGB(LCHtoLAB(labColor), true), 1.0);	
	}
}

void main() {
	// compute the z-position based on the absolute value of the position
	// [minVal, maxVal] -> [1, 0];
	float zpos = abs(position.z) / max(abs(minVal), abs(maxVal));
	zpos = (zpos - 1.0) * -1.0;
	
	
	// translate the x,y position of the point to x,y position in the output texture
	gl_Position = vec4(position.xy / dataSize * vec2(2.0) - vec2(1.0), zpos, 1.0);
	gl_PointSize = 1.0;
	
	vColor = getColorFromColorRamp();
}
