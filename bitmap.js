/*!
 * Generate Bitmap Data URL
 * http://mrcoles.com/low-res-paint/
 *
 * Copyright 2010, Peter Coles
 * Licensed under the MIT licenses.
 * http://mrcoles.com/media/mit-license.txt
 *
 * Date: Tue Oct 26 00:00:00 2010 -0500
 */

/*
 * Code to generate Bitmap images (using data urls) from rows of RGB arrays.
 * Specifically for use with http://mrcoles.com/low-rest-paint/
 *
 * Research:
 *
 * RFC 2397 data URL
 * http://www.xs4all.nl/~wrb/Articles/Article_IMG_RFC2397_P1_01.htm
 *
 * BMP file Format
 * http://en.wikipedia.org/wiki/BMP_file_format#Example_of_a_2.C3.972_Pixel.2C_24-Bit_Bitmap_.28Windows_V3_DIB.29
 *
 * BMP Notes
 *
 * - Integer values are little-endian, including RGB pixels, e.g., (255, 0, 0) -> \x00\x00\xFF
 * - Bitmap data starts at lower left (and reads across rows)
 * - In the BMP data, padding bytes are inserted in order to keep the lines of data in multiples of four,
 *   e.g., a 24-bit bitmap with width 1 would have 3 bytes of data per row (R, G, B) + 1 byte of padding
 */

(function() {

    function _asLittleEndianHex(value, bytes) {
        // Convert value into little endian hex bytes
        // value - the number as a decimal integer (representing bytes)
        // bytes - the number of bytes that this value takes up in a string

        // Example:
        // _asLittleEndianHex(2835, 4)
        // > '\x13\x0b\x00\x00'

        var result = [];

        for (; bytes>0; bytes--) {
            result.push(String.fromCharCode(value & 255));
            value >>= 8;
        }

        return result.join('');
    }

    function _collapseData(rows, row_padding) {
        // Convert rows of RGB arrays into BMP data
        var i,
            rows_len = rows.length,
            j,
            pixels_len = rows_len ? rows[0].length : 0,
            pixel,
            padding = '',
            result = [];

        for (; row_padding > 0; row_padding--) {
            padding += '\x00';
        }

        for (i=0; i<rows_len; i++) {
            for (j=0; j<pixels_len; j++) {
                pixel = rows[i][j];
                result.push(String.fromCharCode(pixel[2]) +
                            String.fromCharCode(pixel[1]) +
                            String.fromCharCode(pixel[0]));
            }
            result.push(padding);
        }

        return result.join('');
    }

    function _scaleRows(rows, scale) {
        // Simplest scaling possible
        var real_w = rows.length,
            scaled_w = parseInt(real_w * scale),
            real_h = real_w ? rows[0].length : 0,
            scaled_h = parseInt(real_h * scale),
            new_rows = [],
            new_row, x, y;

        for (y=0; y<scaled_h; y++) {
            new_rows.push(new_row = []);
            for (x=0; x<scaled_w; x++) {
                new_row.push(rows[parseInt(y/scale)][parseInt(x/scale)]);
            }
        }
        return new_rows;
    }

    window.generateBitmapDataURL = function(rows, scale) {
        // Expects rows starting in bottom left
        // formatted like this: [[[255, 0, 0], [255, 255, 0], ...], ...]
        // which represents: [[red, yellow, ...], ...]

        if (!window.btoa) {
            alert('Oh no, your browser does not support base64 encoding - window.btoa()!!');
            return false;
        }

        scale = scale || 1;
        if (scale != 1) {
            rows = _scaleRows(rows, scale);
        }

        var height = rows.length,                                // the number of rows
            width = height ? rows[0].length : 0,                 // the number of columns per row
            row_padding = (4 - (width * 3) % 4) % 4,             // pad each row to a multiple of 4 bytes
            num_data_bytes = (width * 3 + row_padding) * height, // size in bytes of BMP data
            num_file_bytes = 54 + num_data_bytes,                // full header size (offset) + size of data
            file;

        height = _asLittleEndianHex(height, 4);
        width = _asLittleEndianHex(width, 4);
        num_data_bytes = _asLittleEndianHex(num_data_bytes, 4);
        num_file_bytes = _asLittleEndianHex(num_file_bytes, 4);

        // these are the actual bytes of the file...

        file = ('BM' +               // "Magic Number"
                num_file_bytes +     // size of the file (bytes)*
                '\x00\x00' +         // reserved
                '\x00\x00' +         // reserved
                '\x36\x00\x00\x00' + // offset of where BMP data lives (54 bytes)
                '\x28\x00\x00\x00' + // number of remaining bytes in header from here (40 bytes)
                width +              // the width of the bitmap in pixels*
                height +             // the height of the bitmap in pixels*
                '\x01\x00' +         // the number of color planes (1)
                '\x18\x00' +         // 24 bits / pixel
                '\x00\x00\x00\x00' + // No compression (0)
                num_data_bytes +     // size of the BMP data (bytes)*
                '\x13\x0B\x00\x00' + // 2835 pixels/meter - horizontal resolution
                '\x13\x0B\x00\x00' + // 2835 pixels/meter - the vertical resolution
                '\x00\x00\x00\x00' + // Number of colors in the palette (keep 0 for 24-bit)
                '\x00\x00\x00\x00' + // 0 important colors (means all colors are important)
                _collapseData(rows, row_padding)
               );

        return 'data:image/bmp;base64,' + btoa(file);
    };

})();



//
// Code specific to low res paint
//

(function(window, document, undefined) {

    var $bg_transform;

    function _assign_bg_transform(bg) {
        // different browsers return the color differently
        // let's support "rgb(123, 0, 5)", "#fff", and "#ff0099"
        if (/^rgb\(\d+, \d+, \d+\)$/.test(bg)) {
            $bg_transform = function(x) {
                x = x.split(',');
                x[0] = x[0].substr(4);
                for (var i=0, t; i<3; i++) {
                    x[i] = parseInt(x[i]);
                }
                return x;
            };
        } else if (bg.substring(0,1) == '#') {
            $bg_transform = function(x) {
                x = x.substring(1);
                var i = 0,
                    len = x.length,
                    result = [];
                if (len == 3) {
                    for (; i<len; i++) {
                        result.push(parseInt('0x' + x.substring(i, i+1) + x.substring(i, i+1)));
                    }
                } else {
                    for (; i<len; i+=2) {
                        result.push(parseInt('0x' + x.substring(i, i+2)));
                    }
                }
                return result;
            };
        } else {
            alert('Unparseable color: ' + bg);
        }
    }

    function $bgAsRGB(id) {
        var bg = document.getElementById(id).style.backgroundColor;
        if (bg === '') return [255, 255, 255];
        if ($bg_transform === undefined) {
            _assign_bg_transform(bg);
        }
        return $bg_transform(bg);
    }

    window.generateLowResBitmap = function(scale) {
        // pixels are x_y starting in top left, we need to iterate from bottom left
        // dimensions are a 50x50 square (0, 0, 49, 49)

        scale = scale || 10;

        var x,
            x_len = 50,
            y = 49,
            rows = [],
            row,
            img_parent,
            img,
            src;

        for (; y>=0; y--) {
            rows.push(row = []);
            for (x=0; x<x_len; x++) {
                row.push($bgAsRGB(x + '_' + y));
            }
        }

        /* test image * /
        rows = [
            [[255, 0, 0], [255, 255, 255]],
            [[0, 0, 255], [0, 255,0]]
        ];
        /* */

        img = document.createElement('img');
        src = window.generateBitmapDataURL(rows, scale);
        img.src = src;
        img.alt = 'If you can read this, your browser probably doesn\'t support the data URL scheme format! Oh no!';
        img.title = 'You generated an image, great job! To save it, drag it to your Desktop or right click and select save as.';
        img_parent = document.getElementById('img');
        if (img_parent === null) {
            img_parent = document.createElement('div');
            img_parent.id = 'img';
            document.getElementById('wrap').appendChild(img_parent);
        }
        img_parent.innerHTML = '<div class="img-header">Generated Image &nbsp;<a title="hide image" href="#">x</a></div>';
        img_parent.getElementsByTagName('a')[0].onclick = function() {
            var img_parent = document.getElementById('img');
            img_parent.parentNode.removeChild(img_parent);
            return false;
        };
        img_parent.appendChild(img);
        return false;
    };

    window.generateLowResBitmap.askToScale = function() {
        var scale = prompt('Pick a scaling factor...\n1 = actual size, .5 = half, 2 = double\n(note: large numbers might crash your browser)');
        if (scale) {
            try {
                scale = parseFloat(scale);
            } catch (x) {
                scale = NaN;
            }
            if (isNaN(scale)) {
                alert('That is not a number!');
            } else {
                scale = scale * 10; // since actual size is actually 10x!
                window.generateLowResBitmap(scale);
            }
        }
        return false;
    };
})(this, this.document);
