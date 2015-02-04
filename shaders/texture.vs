varying vec2 coord;

uniform float minVal;

void main() {
	coord = gl_Vertex.xy * 0.5 + 0.5;
	gl_Position = vec4(gl_Vertex.xyz, 1.0);
}
