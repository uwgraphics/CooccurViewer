attribute vec3 position;

uniform float pointSize;
uniform float windowSize;
uniform float minVal;
uniform float maxVal;

uniform int bivariate;
uniform float rampTexWidth;
uniform float numSteps;
uniform sampler2D colorRamp;

varying vec4 vColor;

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
	
	return texture2D(colorRamp, vec2(xCoord, yCoord) + vec2(0.03));
}

void main() {
	gl_Position = gl_ModelViewProjectionMatrix * vec4((position.x + position.y - (windowSize / 2.0)), position.x, -5.0, 1.0);
	gl_PointSize = pointSize;
	
	vColor = getColorFromColorRamp();
}
