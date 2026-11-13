'use strict';

const ASPECT_RATIOS = Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4']);
const IMAGE_SIZE_MAX_DIMENSION = 1536;
const SIZE_BY_ASPECT_RATIO = Object.freeze({
    auto: '1024x1024',
    '1:1': '1024x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
    '4:3': '1365x1024',
    '3:4': '1024x1365',
});

function sizeForAspectRatio(aspectRatio) {
    if (typeof aspectRatio !== 'string' || !ASPECT_RATIOS.includes(aspectRatio)) {
        throw new TypeError('aspectRatio is unsupported');
    }
    return SIZE_BY_ASPECT_RATIO[aspectRatio];
}

module.exports = { ASPECT_RATIOS, IMAGE_SIZE_MAX_DIMENSION, sizeForAspectRatio };
