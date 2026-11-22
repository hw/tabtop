// A bounded WebGL1/WebGL2 command mirror for /go. The page keeps its context in Moli;
// missing engine methods get compatibility shims and calls replay in the viewer.
(() => {
    const Canvas = globalThis.HTMLCanvasElement;
    const GL = globalThis.WebGLRenderingContext;
    const GL2 = globalThis.WebGL2RenderingContext;
    if (!Canvas || !GL) return;

    const apply = Reflect.apply;
    const contexts = new WeakMap();
    const contextByCanvas = new WeakMap();
    const originalGetContext = Canvas.prototype.getContext;
    const originalDispatch = EventTarget.prototype.dispatchEvent;
    const EventCtor = Event;
    const CustomEventCtor = CustomEvent;
    const maxCommands = 4096;
    const maxData = 2 << 20;
    const maxJSON = 4 << 20;
    // Moli exposes the WebGL methods needed for mirroring but omits a number
    // of standard context constants. Supply the WebGL1 enum values so page
    // code and the viewer agree on the commands being recorded.
    const enums = {
        ZERO: 0, ONE: 1, POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
        DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400, COLOR_BUFFER_BIT: 0x4000,
        FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408, CULL_FACE: 0x0B44, BLEND: 0x0BE2, DITHER: 0x0BD0,
        STENCIL_TEST: 0x0B90, DEPTH_TEST: 0x0B71, SCISSOR_TEST: 0x0C11, POLYGON_OFFSET_FILL: 0x8037,
        CW: 0x0900, CCW: 0x0901, NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,
        BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
        UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
        ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
        VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
        NO_ERROR: 0, MAX_TEXTURE_SIZE: 0x0D33, MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, MAX_RENDERBUFFER_SIZE: 0x84E8, MAX_VIEWPORT_DIMS: 0x0D3A,
        MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, MAX_VARYING_VECTORS: 0x8DFC,
        MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
        ACTIVE_TEXTURE: 0x84E0, ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895, CURRENT_PROGRAM: 0x8B8D,
        VERTEX_ARRAY_BINDING: 0x85B5, SAMPLER_BINDING: 0x8919, UNIFORM_BUFFER: 0x8A11, UNIFORM_BUFFER_BINDING: 0x8A28, PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC,
        TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A, MAX_3D_TEXTURE_SIZE: 0x8073, MAX_ARRAY_TEXTURE_LAYERS: 0x88FF,
        TEXTURE_BINDING_2D: 0x8069, TEXTURE_BINDING_CUBE_MAP: 0x8514, TEXTURE_BINDING_3D: 0x806A, TEXTURE_BINDING_2D_ARRAY: 0x8C1D, FRAMEBUFFER_BINDING: 0x8CA6, RENDERBUFFER_BINDING: 0x8CA7,
        VIEWPORT: 0x0BA2, COLOR_CLEAR_VALUE: 0x0C22, DEPTH_CLEAR_VALUE: 0x0B73, STENCIL_CLEAR_VALUE: 0x0B91,
        COLOR_WRITEMASK: 0x0C23, DEPTH_WRITEMASK: 0x0B72, BLEND_COLOR: 0x8005, CULL_FACE_MODE: 0x0B45, FRONT_FACE: 0x0B46,
        SCISSOR_BOX: 0x0C10, LINE_WIDTH: 0x0B21, DEPTH_FUNC: 0x0B74,
        FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A,
        FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6, FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7, FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
        RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43, RENDERBUFFER_INTERNAL_FORMAT: 0x8D44, DEPTH_COMPONENT16: 0x81A5, STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9,
        RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62,
        RED: 0x1903, RG: 0x8227, R8: 0x8229, RG8: 0x822B, RGB8: 0x8051, RGBA8: 0x8058, SRGB8_ALPHA8: 0x8C43,
        TEXTURE_2D: 0x0DE1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
        TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517, TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518, TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
        TEXTURE0: 0x84C0, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
        NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
        REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
        DEPTH_COMPONENT: 0x1902, HALF_FLOAT: 0x140B, HALF_FLOAT_OES: 0x8D61, UNSIGNED_INT_24_8_WEBGL: 0x84FA, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF,
        UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244, UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
    };
    const gl2Enums = {
        COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37, DRAW_FRAMEBUFFER: 0x8CA9, READ_FRAMEBUFFER: 0x8CA8,
        DRAW_FRAMEBUFFER_BINDING: 0x8CA6, READ_FRAMEBUFFER_BINDING: 0x8CAA, TRANSFORM_FEEDBACK: 0x8E22, TRANSFORM_FEEDBACK_BINDING: 0x8E25,
        TRANSFORM_FEEDBACK_BUFFER: 0x8C8E, TRANSFORM_FEEDBACK_BUFFER_BINDING: 0x8C8F, INTERLEAVED_ATTRIBS: 0x8C8C, SEPARATE_ATTRIBS: 0x8C8D,
        RASTERIZER_DISCARD: 0x8C89, QUERY_RESULT: 0x8866, QUERY_RESULT_AVAILABLE: 0x8867, ANY_SAMPLES_PASSED: 0x8C2F,
        ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8D6A, MAX_DRAW_BUFFERS: 0x8824, MAX_COLOR_ATTACHMENTS: 0x8CDF,
        UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8A34, INVALID_INDEX: 0xFFFFFFFF, RED_INTEGER: 0x8D94, RG_INTEGER: 0x8228, RGB_INTEGER: 0x8D98, RGBA_INTEGER: 0x8D99,
        RGB10_A2: 0x8059, RGB10_A2UI: 0x906F, R16F: 0x822D, RG16F: 0x822F, RGB16F: 0x881B, RGBA16F: 0x881A,
        R32F: 0x822E, RG32F: 0x8230, RGB32F: 0x8815, RGBA32F: 0x8814, R8I: 0x8231, R8UI: 0x8232, R16I: 0x8233, R16UI: 0x8234, R32I: 0x8235, R32UI: 0x8236,
        RG8I: 0x8237, RG8UI: 0x8238, RG16I: 0x8239, RG16UI: 0x823A, RG32I: 0x823B, RG32UI: 0x823C,
        RGB8I: 0x8D8F, RGB8UI: 0x8D7D, RGB16I: 0x8D89, RGB16UI: 0x8D77, RGB32I: 0x8D83, RGB32UI: 0x8D71,
        RGBA8I: 0x8D8E, RGBA8UI: 0x8D7C, RGBA16I: 0x8D88, RGBA16UI: 0x8D76, RGBA32I: 0x8D82, RGBA32UI: 0x8D70,
        R8_SNORM: 0x8F94, RG8_SNORM: 0x8F95, RGB8_SNORM: 0x8F96, RGBA8_SNORM: 0x8F97,
        PACK_ROW_LENGTH: 0x0D02, PACK_SKIP_ROWS: 0x0D03, PACK_SKIP_PIXELS: 0x0D04,
        UNPACK_ROW_LENGTH: 0x0CF2, UNPACK_SKIP_ROWS: 0x0CF3, UNPACK_SKIP_PIXELS: 0x0CF4, UNPACK_SKIP_IMAGES: 0x806D, UNPACK_IMAGE_HEIGHT: 0x806E,
        PIXEL_PACK_BUFFER_BINDING: 0x88ED, PIXEL_UNPACK_BUFFER_BINDING: 0x88EF,
        TEXTURE_WRAP_R: 0x8072, TEXTURE_MIN_LOD: 0x813A, TEXTURE_MAX_LOD: 0x813B, TEXTURE_BASE_LEVEL: 0x813C, TEXTURE_MAX_LEVEL: 0x813D,
        TEXTURE_COMPARE_MODE: 0x884C, TEXTURE_COMPARE_FUNC: 0x884D, COMPARE_REF_TO_TEXTURE: 0x884E,
        DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32F: 0x8CAC, DEPTH24_STENCIL8: 0x88F0, DEPTH32F_STENCIL8: 0x8CAD,
        UNSIGNED_INT_24_8: 0x84FA, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8DAD, UNSIGNED_NORMALIZED: 0x8C17,
        FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING: 0x8210, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: 0x8211,
        FRAMEBUFFER_ATTACHMENT_RED_SIZE: 0x8212, FRAMEBUFFER_ATTACHMENT_GREEN_SIZE: 0x8213,
        FRAMEBUFFER_ATTACHMENT_BLUE_SIZE: 0x8214, FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE: 0x8215,
        FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE: 0x8216, FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE: 0x8217,
        FRAMEBUFFER_DEFAULT: 0x8218, FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER: 0x8CD4, RENDERBUFFER_SAMPLES: 0x8CAB,
        SAMPLER_3D: 0x8B5F, SAMPLER_2D_SHADOW: 0x8B62, SAMPLER_2D_ARRAY: 0x8DC1, SAMPLER_2D_ARRAY_SHADOW: 0x8DC4, SAMPLER_CUBE_SHADOW: 0x8DC5,
        INT_SAMPLER_2D: 0x8DCA, INT_SAMPLER_3D: 0x8DCB, INT_SAMPLER_CUBE: 0x8DCC, INT_SAMPLER_2D_ARRAY: 0x8DCF,
        UNSIGNED_INT_SAMPLER_2D: 0x8DD2, UNSIGNED_INT_SAMPLER_3D: 0x8DD3, UNSIGNED_INT_SAMPLER_CUBE: 0x8DD4, UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8DD7,
        UNSIGNED_INT_VEC2: 0x8DC6, UNSIGNED_INT_VEC3: 0x8DC7, UNSIGNED_INT_VEC4: 0x8DC8,
        FLOAT_MAT2x3: 0x8B65, FLOAT_MAT2x4: 0x8B66, FLOAT_MAT3x2: 0x8B67, FLOAT_MAT3x4: 0x8B68, FLOAT_MAT4x2: 0x8B69, FLOAT_MAT4x3: 0x8B6A,
        FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8D56, MAX_SAMPLES: 0x8D57, UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B,
        UNSIGNED_INT_5_9_9_9_REV: 0x8C3E, UNSIGNED_INT_2_10_10_10_REV: 0x8368, INT_2_10_10_10_REV: 0x8D9F,
        CURRENT_QUERY: 0x8865, MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: 0x8C8B, MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 0x8C8A,
        MAX_VERTEX_UNIFORM_BLOCKS: 0x8A2B, MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8A2D, MAX_COMBINED_UNIFORM_BLOCKS: 0x8A2E,
        MAX_UNIFORM_BUFFER_BINDINGS: 0x8A2F, MAX_UNIFORM_BLOCK_SIZE: 0x8A30, MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS: 0x8A31,
        MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS: 0x8A33, ACTIVE_UNIFORM_BLOCKS: 0x8A36,
        UNIFORM_TYPE: 0x8A37, UNIFORM_SIZE: 0x8A38, UNIFORM_BLOCK_INDEX: 0x8A3A, UNIFORM_OFFSET: 0x8A3B,
        UNIFORM_ARRAY_STRIDE: 0x8A3C, UNIFORM_MATRIX_STRIDE: 0x8A3D, UNIFORM_IS_ROW_MAJOR: 0x8A3E,
        UNIFORM_BLOCK_BINDING: 0x8A3F, UNIFORM_BLOCK_DATA_SIZE: 0x8A40, UNIFORM_BLOCK_ACTIVE_UNIFORMS: 0x8A42,
        UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: 0x8A43, UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER: 0x8A44,
        UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: 0x8A46, TRANSFORM_FEEDBACK_BUFFER_MODE: 0x8C7F,
        TRANSFORM_FEEDBACK_VARYINGS: 0x8C83, TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN: 0x8C88,
        TRANSFORM_FEEDBACK_ACTIVE: 0x8E24, TRANSFORM_FEEDBACK_PAUSED: 0x8E23, VERTEX_ATTRIB_ARRAY_DIVISOR: 0x88FE,
        MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122, MAX_FRAGMENT_INPUT_COMPONENTS: 0x9125,
        MAX_VARYING_COMPONENTS: 0x8B4B, MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: 0x8C80,
    };
    for (let i = 0; i < 16; i++) { gl2Enums[`DRAW_BUFFER${i}`] = 0x8825 + i; if (i > 0) gl2Enums[`COLOR_ATTACHMENT${i}`] = 0x8CE0 + i; }

    // Every standard WebGL1 and WebGL2 constant (NAME:hex), as a browser has
    // them on its contexts' prototypes and constructors: Moli has few, and
    // pages and libraries (three.js) use them by name.
    const standardEnums1 = (
        "NONE:0 NO_ERROR:0 POINTS:0 ZERO:0 LINES:1 ONE:1 LINE_LOOP:2 LINE_STRIP:3 TRIANGLES:4 TRIANGLE_STRIP:5 TRIANGLE_FAN:6 DEPTH_BUFFER_BIT:100 " +
        "NEVER:200 LESS:201 EQUAL:202 LEQUAL:203 GREATER:204 NOTEQUAL:205 GEQUAL:206 ALWAYS:207 SRC_COLOR:300 ONE_MINUS_SRC_COLOR:301 SRC_ALPHA:302 " +
        "ONE_MINUS_SRC_ALPHA:303 DST_ALPHA:304 ONE_MINUS_DST_ALPHA:305 DST_COLOR:306 ONE_MINUS_DST_COLOR:307 SRC_ALPHA_SATURATE:308 " +
        "STENCIL_BUFFER_BIT:400 FRONT:404 BACK:405 FRONT_AND_BACK:408 INVALID_ENUM:500 INVALID_VALUE:501 INVALID_OPERATION:502 OUT_OF_MEMORY:505 " +
        "INVALID_FRAMEBUFFER_OPERATION:506 CW:900 CCW:901 LINE_WIDTH:b21 CULL_FACE:b44 CULL_FACE_MODE:b45 FRONT_FACE:b46 DEPTH_RANGE:b70 " +
        "DEPTH_TEST:b71 DEPTH_WRITEMASK:b72 DEPTH_CLEAR_VALUE:b73 DEPTH_FUNC:b74 STENCIL_TEST:b90 STENCIL_CLEAR_VALUE:b91 STENCIL_FUNC:b92 " +
        "STENCIL_VALUE_MASK:b93 STENCIL_FAIL:b94 STENCIL_PASS_DEPTH_FAIL:b95 STENCIL_PASS_DEPTH_PASS:b96 STENCIL_REF:b97 STENCIL_WRITEMASK:b98 " +
        "VIEWPORT:ba2 DITHER:bd0 BLEND:be2 SCISSOR_BOX:c10 SCISSOR_TEST:c11 COLOR_CLEAR_VALUE:c22 COLOR_WRITEMASK:c23 UNPACK_ALIGNMENT:cf5 " +
        "PACK_ALIGNMENT:d05 MAX_TEXTURE_SIZE:d33 MAX_VIEWPORT_DIMS:d3a SUBPIXEL_BITS:d50 RED_BITS:d52 GREEN_BITS:d53 BLUE_BITS:d54 ALPHA_BITS:d55 " +
        "DEPTH_BITS:d56 STENCIL_BITS:d57 TEXTURE_2D:de1 DONT_CARE:1100 FASTEST:1101 NICEST:1102 BYTE:1400 UNSIGNED_BYTE:1401 SHORT:1402 " +
        "UNSIGNED_SHORT:1403 INT:1404 UNSIGNED_INT:1405 FLOAT:1406 INVERT:150a TEXTURE:1702 DEPTH_COMPONENT:1902 ALPHA:1906 RGB:1907 RGBA:1908 " +
        "LUMINANCE:1909 LUMINANCE_ALPHA:190a KEEP:1e00 REPLACE:1e01 INCR:1e02 DECR:1e03 VENDOR:1f00 RENDERER:1f01 VERSION:1f02 NEAREST:2600 " +
        "LINEAR:2601 NEAREST_MIPMAP_NEAREST:2700 LINEAR_MIPMAP_NEAREST:2701 NEAREST_MIPMAP_LINEAR:2702 LINEAR_MIPMAP_LINEAR:2703 " +
        "TEXTURE_MAG_FILTER:2800 TEXTURE_MIN_FILTER:2801 TEXTURE_WRAP_S:2802 TEXTURE_WRAP_T:2803 REPEAT:2901 POLYGON_OFFSET_UNITS:2a00 " +
        "COLOR_BUFFER_BIT:4000 CONSTANT_COLOR:8001 ONE_MINUS_CONSTANT_COLOR:8002 CONSTANT_ALPHA:8003 ONE_MINUS_CONSTANT_ALPHA:8004 BLEND_COLOR:8005 " +
        "FUNC_ADD:8006 BLEND_EQUATION:8009 BLEND_EQUATION_RGB:8009 FUNC_SUBTRACT:800a FUNC_REVERSE_SUBTRACT:800b UNSIGNED_SHORT_4_4_4_4:8033 " +
        "UNSIGNED_SHORT_5_5_5_1:8034 POLYGON_OFFSET_FILL:8037 POLYGON_OFFSET_FACTOR:8038 RGB8:8051 RGBA4:8056 RGB5_A1:8057 RGBA8:8058 " +
        "TEXTURE_BINDING_2D:8069 SAMPLE_ALPHA_TO_COVERAGE:809e SAMPLE_COVERAGE:80a0 SAMPLE_BUFFERS:80a8 SAMPLES:80a9 SAMPLE_COVERAGE_VALUE:80aa " +
        "SAMPLE_COVERAGE_INVERT:80ab BLEND_DST_RGB:80c8 BLEND_SRC_RGB:80c9 BLEND_DST_ALPHA:80ca BLEND_SRC_ALPHA:80cb CLAMP_TO_EDGE:812f " +
        "GENERATE_MIPMAP_HINT:8192 DEPTH_COMPONENT16:81a5 DEPTH_STENCIL_ATTACHMENT:821a UNSIGNED_SHORT_5_6_5:8363 MIRRORED_REPEAT:8370 " +
        "ALIASED_POINT_SIZE_RANGE:846d ALIASED_LINE_WIDTH_RANGE:846e TEXTURE0:84c0 TEXTURE1:84c1 TEXTURE2:84c2 TEXTURE3:84c3 TEXTURE4:84c4 " +
        "TEXTURE5:84c5 TEXTURE6:84c6 TEXTURE7:84c7 TEXTURE8:84c8 TEXTURE9:84c9 TEXTURE10:84ca TEXTURE11:84cb TEXTURE12:84cc TEXTURE13:84cd " +
        "TEXTURE14:84ce TEXTURE15:84cf TEXTURE16:84d0 TEXTURE17:84d1 TEXTURE18:84d2 TEXTURE19:84d3 TEXTURE20:84d4 TEXTURE21:84d5 TEXTURE22:84d6 " +
        "TEXTURE23:84d7 TEXTURE24:84d8 TEXTURE25:84d9 TEXTURE26:84da TEXTURE27:84db TEXTURE28:84dc TEXTURE29:84dd TEXTURE30:84de TEXTURE31:84df " +
        "ACTIVE_TEXTURE:84e0 MAX_RENDERBUFFER_SIZE:84e8 DEPTH_STENCIL:84f9 INCR_WRAP:8507 DECR_WRAP:8508 TEXTURE_CUBE_MAP:8513 " +
        "TEXTURE_BINDING_CUBE_MAP:8514 TEXTURE_CUBE_MAP_POSITIVE_X:8515 TEXTURE_CUBE_MAP_NEGATIVE_X:8516 TEXTURE_CUBE_MAP_POSITIVE_Y:8517 " +
        "TEXTURE_CUBE_MAP_NEGATIVE_Y:8518 TEXTURE_CUBE_MAP_POSITIVE_Z:8519 TEXTURE_CUBE_MAP_NEGATIVE_Z:851a MAX_CUBE_MAP_TEXTURE_SIZE:851c " +
        "VERTEX_ATTRIB_ARRAY_ENABLED:8622 VERTEX_ATTRIB_ARRAY_SIZE:8623 VERTEX_ATTRIB_ARRAY_STRIDE:8624 VERTEX_ATTRIB_ARRAY_TYPE:8625 " +
        "CURRENT_VERTEX_ATTRIB:8626 VERTEX_ATTRIB_ARRAY_POINTER:8645 COMPRESSED_TEXTURE_FORMATS:86a3 BUFFER_SIZE:8764 BUFFER_USAGE:8765 " +
        "STENCIL_BACK_FUNC:8800 STENCIL_BACK_FAIL:8801 STENCIL_BACK_PASS_DEPTH_FAIL:8802 STENCIL_BACK_PASS_DEPTH_PASS:8803 BLEND_EQUATION_ALPHA:883d " +
        "MAX_VERTEX_ATTRIBS:8869 VERTEX_ATTRIB_ARRAY_NORMALIZED:886a MAX_TEXTURE_IMAGE_UNITS:8872 ARRAY_BUFFER:8892 ELEMENT_ARRAY_BUFFER:8893 " +
        "ARRAY_BUFFER_BINDING:8894 ELEMENT_ARRAY_BUFFER_BINDING:8895 VERTEX_ATTRIB_ARRAY_BUFFER_BINDING:889f STREAM_DRAW:88e0 STATIC_DRAW:88e4 " +
        "DYNAMIC_DRAW:88e8 FRAGMENT_SHADER:8b30 VERTEX_SHADER:8b31 MAX_VERTEX_TEXTURE_IMAGE_UNITS:8b4c MAX_COMBINED_TEXTURE_IMAGE_UNITS:8b4d " +
        "SHADER_TYPE:8b4f FLOAT_VEC2:8b50 FLOAT_VEC3:8b51 FLOAT_VEC4:8b52 INT_VEC2:8b53 INT_VEC3:8b54 INT_VEC4:8b55 BOOL:8b56 BOOL_VEC2:8b57 " +
        "BOOL_VEC3:8b58 BOOL_VEC4:8b59 FLOAT_MAT2:8b5a FLOAT_MAT3:8b5b FLOAT_MAT4:8b5c SAMPLER_2D:8b5e SAMPLER_CUBE:8b60 DELETE_STATUS:8b80 " +
        "COMPILE_STATUS:8b81 LINK_STATUS:8b82 VALIDATE_STATUS:8b83 ATTACHED_SHADERS:8b85 ACTIVE_UNIFORMS:8b86 ACTIVE_ATTRIBUTES:8b89 " +
        "SHADING_LANGUAGE_VERSION:8b8c CURRENT_PROGRAM:8b8d IMPLEMENTATION_COLOR_READ_TYPE:8b9a IMPLEMENTATION_COLOR_READ_FORMAT:8b9b " +
        "STENCIL_BACK_REF:8ca3 STENCIL_BACK_VALUE_MASK:8ca4 STENCIL_BACK_WRITEMASK:8ca5 FRAMEBUFFER_BINDING:8ca6 RENDERBUFFER_BINDING:8ca7 " +
        "FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:8cd0 FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:8cd1 FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:8cd2 " +
        "FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:8cd3 FRAMEBUFFER_COMPLETE:8cd5 FRAMEBUFFER_INCOMPLETE_ATTACHMENT:8cd6 " +
        "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:8cd7 FRAMEBUFFER_INCOMPLETE_DIMENSIONS:8cd9 FRAMEBUFFER_UNSUPPORTED:8cdd COLOR_ATTACHMENT0:8ce0 " +
        "DEPTH_ATTACHMENT:8d00 STENCIL_ATTACHMENT:8d20 FRAMEBUFFER:8d40 RENDERBUFFER:8d41 RENDERBUFFER_WIDTH:8d42 RENDERBUFFER_HEIGHT:8d43 " +
        "RENDERBUFFER_INTERNAL_FORMAT:8d44 STENCIL_INDEX8:8d48 RENDERBUFFER_RED_SIZE:8d50 RENDERBUFFER_GREEN_SIZE:8d51 RENDERBUFFER_BLUE_SIZE:8d52 " +
        "RENDERBUFFER_ALPHA_SIZE:8d53 RENDERBUFFER_DEPTH_SIZE:8d54 RENDERBUFFER_STENCIL_SIZE:8d55 RGB565:8d62 LOW_FLOAT:8df0 MEDIUM_FLOAT:8df1 " +
        "HIGH_FLOAT:8df2 LOW_INT:8df3 MEDIUM_INT:8df4 HIGH_INT:8df5 MAX_VERTEX_UNIFORM_VECTORS:8dfb MAX_VARYING_VECTORS:8dfc " +
        "MAX_FRAGMENT_UNIFORM_VECTORS:8dfd UNPACK_FLIP_Y_WEBGL:9240 UNPACK_PREMULTIPLY_ALPHA_WEBGL:9241 CONTEXT_LOST_WEBGL:9242 " +
        "UNPACK_COLORSPACE_CONVERSION_WEBGL:9243 BROWSER_DEFAULT_WEBGL:9244 "
    );
    const standardEnums2 = (
        "TIMEOUT_IGNORED:-1 SYNC_FLUSH_COMMANDS_BIT:1 READ_BUFFER:c02 UNPACK_ROW_LENGTH:cf2 UNPACK_SKIP_ROWS:cf3 UNPACK_SKIP_PIXELS:cf4 " +
        "PACK_ROW_LENGTH:d02 PACK_SKIP_ROWS:d03 PACK_SKIP_PIXELS:d04 HALF_FLOAT:140b COLOR:1800 DEPTH:1801 STENCIL:1802 RED:1903 MIN:8007 MAX:8008 " +
        "RGB10_A2:8059 TEXTURE_BINDING_3D:806a UNPACK_SKIP_IMAGES:806d UNPACK_IMAGE_HEIGHT:806e TEXTURE_3D:806f TEXTURE_WRAP_R:8072 " +
        "MAX_3D_TEXTURE_SIZE:8073 MAX_ELEMENTS_VERTICES:80e8 MAX_ELEMENTS_INDICES:80e9 TEXTURE_MIN_LOD:813a TEXTURE_MAX_LOD:813b " +
        "TEXTURE_BASE_LEVEL:813c TEXTURE_MAX_LEVEL:813d DEPTH_COMPONENT24:81a6 FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:8210 " +
        "FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:8211 FRAMEBUFFER_ATTACHMENT_RED_SIZE:8212 FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:8213 " +
        "FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:8214 FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:8215 FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:8216 " +
        "FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:8217 FRAMEBUFFER_DEFAULT:8218 RG:8227 RG_INTEGER:8228 R8:8229 RG8:822b R16F:822d R32F:822e RG16F:822f " +
        "RG32F:8230 R8I:8231 R8UI:8232 R16I:8233 R16UI:8234 R32I:8235 R32UI:8236 RG8I:8237 RG8UI:8238 RG16I:8239 RG16UI:823a RG32I:823b RG32UI:823c " +
        "TEXTURE_IMMUTABLE_LEVELS:82df UNSIGNED_INT_2_10_10_10_REV:8368 UNSIGNED_INT_24_8:84fa MAX_TEXTURE_LOD_BIAS:84fd VERTEX_ARRAY_BINDING:85b5 " +
        "RGBA32F:8814 RGB32F:8815 RGBA16F:881a RGB16F:881b MAX_DRAW_BUFFERS:8824 DRAW_BUFFER0:8825 DRAW_BUFFER1:8826 DRAW_BUFFER2:8827 " +
        "DRAW_BUFFER3:8828 DRAW_BUFFER4:8829 DRAW_BUFFER5:882a DRAW_BUFFER6:882b DRAW_BUFFER7:882c DRAW_BUFFER8:882d DRAW_BUFFER9:882e " +
        "DRAW_BUFFER10:882f DRAW_BUFFER11:8830 DRAW_BUFFER12:8831 DRAW_BUFFER13:8832 DRAW_BUFFER14:8833 DRAW_BUFFER15:8834 TEXTURE_COMPARE_MODE:884c " +
        "TEXTURE_COMPARE_FUNC:884d COMPARE_REF_TO_TEXTURE:884e CURRENT_QUERY:8865 QUERY_RESULT:8866 QUERY_RESULT_AVAILABLE:8867 STREAM_READ:88e1 " +
        "STREAM_COPY:88e2 STATIC_READ:88e5 STATIC_COPY:88e6 DYNAMIC_READ:88e9 DYNAMIC_COPY:88ea PIXEL_PACK_BUFFER:88eb PIXEL_UNPACK_BUFFER:88ec " +
        "PIXEL_PACK_BUFFER_BINDING:88ed PIXEL_UNPACK_BUFFER_BINDING:88ef DEPTH24_STENCIL8:88f0 VERTEX_ATTRIB_ARRAY_INTEGER:88fd " +
        "VERTEX_ATTRIB_ARRAY_DIVISOR:88fe MAX_ARRAY_TEXTURE_LAYERS:88ff MIN_PROGRAM_TEXEL_OFFSET:8904 MAX_PROGRAM_TEXEL_OFFSET:8905 " +
        "SAMPLER_BINDING:8919 UNIFORM_BUFFER:8a11 UNIFORM_BUFFER_BINDING:8a28 UNIFORM_BUFFER_START:8a29 UNIFORM_BUFFER_SIZE:8a2a " +
        "MAX_VERTEX_UNIFORM_BLOCKS:8a2b MAX_FRAGMENT_UNIFORM_BLOCKS:8a2d MAX_COMBINED_UNIFORM_BLOCKS:8a2e MAX_UNIFORM_BUFFER_BINDINGS:8a2f " +
        "MAX_UNIFORM_BLOCK_SIZE:8a30 MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS:8a31 MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS:8a33 " +
        "UNIFORM_BUFFER_OFFSET_ALIGNMENT:8a34 ACTIVE_UNIFORM_BLOCKS:8a36 UNIFORM_TYPE:8a37 UNIFORM_SIZE:8a38 UNIFORM_BLOCK_INDEX:8a3a " +
        "UNIFORM_OFFSET:8a3b UNIFORM_ARRAY_STRIDE:8a3c UNIFORM_MATRIX_STRIDE:8a3d UNIFORM_IS_ROW_MAJOR:8a3e UNIFORM_BLOCK_BINDING:8a3f " +
        "UNIFORM_BLOCK_DATA_SIZE:8a40 UNIFORM_BLOCK_ACTIVE_UNIFORMS:8a42 UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES:8a43 " +
        "UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:8a44 UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:8a46 MAX_FRAGMENT_UNIFORM_COMPONENTS:8b49 " +
        "MAX_VERTEX_UNIFORM_COMPONENTS:8b4a MAX_VARYING_COMPONENTS:8b4b SAMPLER_3D:8b5f SAMPLER_2D_SHADOW:8b62 FLOAT_MAT2x3:8b65 FLOAT_MAT2x4:8b66 " +
        "FLOAT_MAT3x2:8b67 FLOAT_MAT3x4:8b68 FLOAT_MAT4x2:8b69 FLOAT_MAT4x3:8b6a FRAGMENT_SHADER_DERIVATIVE_HINT:8b8b UNSIGNED_NORMALIZED:8c17 " +
        "TEXTURE_2D_ARRAY:8c1a TEXTURE_BINDING_2D_ARRAY:8c1d ANY_SAMPLES_PASSED:8c2f R11F_G11F_B10F:8c3a UNSIGNED_INT_10F_11F_11F_REV:8c3b " +
        "RGB9_E5:8c3d UNSIGNED_INT_5_9_9_9_REV:8c3e SRGB:8c40 SRGB8:8c41 SRGB8_ALPHA8:8c43 TRANSFORM_FEEDBACK_BUFFER_MODE:8c7f " +
        "MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS:8c80 TRANSFORM_FEEDBACK_VARYINGS:8c83 TRANSFORM_FEEDBACK_BUFFER_START:8c84 " +
        "TRANSFORM_FEEDBACK_BUFFER_SIZE:8c85 TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN:8c88 RASTERIZER_DISCARD:8c89 " +
        "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS:8c8a MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS:8c8b INTERLEAVED_ATTRIBS:8c8c " +
        "SEPARATE_ATTRIBS:8c8d TRANSFORM_FEEDBACK_BUFFER:8c8e TRANSFORM_FEEDBACK_BUFFER_BINDING:8c8f DRAW_FRAMEBUFFER_BINDING:8ca6 " +
        "READ_FRAMEBUFFER:8ca8 DRAW_FRAMEBUFFER:8ca9 READ_FRAMEBUFFER_BINDING:8caa RENDERBUFFER_SAMPLES:8cab DEPTH_COMPONENT32F:8cac " +
        "DEPTH32F_STENCIL8:8cad FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:8cd4 MAX_COLOR_ATTACHMENTS:8cdf COLOR_ATTACHMENT1:8ce1 COLOR_ATTACHMENT2:8ce2 " +
        "COLOR_ATTACHMENT3:8ce3 COLOR_ATTACHMENT4:8ce4 COLOR_ATTACHMENT5:8ce5 COLOR_ATTACHMENT6:8ce6 COLOR_ATTACHMENT7:8ce7 COLOR_ATTACHMENT8:8ce8 " +
        "COLOR_ATTACHMENT9:8ce9 COLOR_ATTACHMENT10:8cea COLOR_ATTACHMENT11:8ceb COLOR_ATTACHMENT12:8cec COLOR_ATTACHMENT13:8ced " +
        "COLOR_ATTACHMENT14:8cee COLOR_ATTACHMENT15:8cef FRAMEBUFFER_INCOMPLETE_MULTISAMPLE:8d56 MAX_SAMPLES:8d57 " +
        "ANY_SAMPLES_PASSED_CONSERVATIVE:8d6a MAX_ELEMENT_INDEX:8d6b RGBA32UI:8d70 RGB32UI:8d71 RGBA16UI:8d76 RGB16UI:8d77 RGBA8UI:8d7c RGB8UI:8d7d " +
        "RGBA32I:8d82 RGB32I:8d83 RGBA16I:8d88 RGB16I:8d89 RGBA8I:8d8e RGB8I:8d8f RED_INTEGER:8d94 RGB_INTEGER:8d98 RGBA_INTEGER:8d99 " +
        "INT_2_10_10_10_REV:8d9f FLOAT_32_UNSIGNED_INT_24_8_REV:8dad SAMPLER_2D_ARRAY:8dc1 SAMPLER_2D_ARRAY_SHADOW:8dc4 SAMPLER_CUBE_SHADOW:8dc5 " +
        "UNSIGNED_INT_VEC2:8dc6 UNSIGNED_INT_VEC3:8dc7 UNSIGNED_INT_VEC4:8dc8 INT_SAMPLER_2D:8dca INT_SAMPLER_3D:8dcb INT_SAMPLER_CUBE:8dcc " +
        "INT_SAMPLER_2D_ARRAY:8dcf UNSIGNED_INT_SAMPLER_2D:8dd2 UNSIGNED_INT_SAMPLER_3D:8dd3 UNSIGNED_INT_SAMPLER_CUBE:8dd4 " +
        "UNSIGNED_INT_SAMPLER_2D_ARRAY:8dd7 TRANSFORM_FEEDBACK:8e22 TRANSFORM_FEEDBACK_PAUSED:8e23 TRANSFORM_FEEDBACK_ACTIVE:8e24 " +
        "TRANSFORM_FEEDBACK_BINDING:8e25 COPY_READ_BUFFER:8f36 COPY_READ_BUFFER_BINDING:8f36 COPY_WRITE_BUFFER:8f37 COPY_WRITE_BUFFER_BINDING:8f37 " +
        "R8_SNORM:8f94 RG8_SNORM:8f95 RGB8_SNORM:8f96 RGBA8_SNORM:8f97 SIGNED_NORMALIZED:8f9c RGB10_A2UI:906f MAX_SERVER_WAIT_TIMEOUT:9111 " +
        "OBJECT_TYPE:9112 SYNC_CONDITION:9113 SYNC_STATUS:9114 SYNC_FLAGS:9115 SYNC_FENCE:9116 SYNC_GPU_COMMANDS_COMPLETE:9117 UNSIGNALED:9118 " +
        "SIGNALED:9119 ALREADY_SIGNALED:911a TIMEOUT_EXPIRED:911b CONDITION_SATISFIED:911c WAIT_FAILED:911d MAX_VERTEX_OUTPUT_COMPONENTS:9122 " +
        "MAX_FRAGMENT_INPUT_COMPONENTS:9125 TEXTURE_IMMUTABLE_FORMAT:912f MAX_CLIENT_WAIT_TIMEOUT_WEBGL:9247 INVALID_INDEX:ffffffff "
    );
    for (const [target, tables] of [[GL, [standardEnums1]], ...(GL2 ? [[GL2, [standardEnums1, standardEnums2]]] : [])]) {
        for (const table of tables) {
            for (const item of table.trim().split(" ")) {
                const at = item.indexOf(":"), name = item.slice(0, at), value = Number.parseInt(item.slice(at + 1), 16);
                for (const where of [target, target.prototype]) {
                    if (typeof where[name] === "number") continue;
                    try { Object.defineProperty(where, name, { value, enumerable: true }); } catch { /* sealed */ }
                }
            }
        }
    }

    for (const proto of [GL.prototype, GL2?.prototype]) {
        if (!proto) continue;
        for (const [name, side] of [["drawingBufferWidth", "width"], ["drawingBufferHeight", "height"]]) {
            if (name in proto) continue;
            try { Object.defineProperty(proto, name, { configurable: true, enumerable: true, get() { return this.canvas?.[side] ?? 0; } }); } catch { /* sealed */ }
        }
    }

    // An attribute's location comes from the program's reflection (below),
    // once linked: Moli doesn't find attributes declared "in" (GLSL ES 3).
    // Installed under the recorder, so the location it records maps to the
    // attribute's name, which the viewer looks up in its own program.
    for (const proto of [GL.prototype, GL2?.prototype]) {
        if (!proto || typeof proto.getActiveAttrib === "function") continue;
        const native = typeof proto.getAttribLocation === "function" ? proto.getAttribLocation : null;
        try {
            Object.defineProperty(proto, "getAttribLocation", { configurable: true, writable: true, value: function (program, name) {
                const locations = programInfo.get(program)?.locations;
                if (locations) return locations.get(String(name)) ?? -1;
                return native ? apply(native, this, [program, name]) : -1;
            } });
        } catch { /* sealed */ }
    }

    const allowed = new Set((
        "activeTexture attachShader disableVertexAttribArray bindAttribLocation bindBuffer bindTexture blendColor blendEquation blendEquationSeparate blendFunc blendFuncSeparate " +
        "bindFramebuffer bindRenderbuffer bufferData bufferSubData clear clearColor clearDepth clearStencil colorMask compileShader copyTexImage2D copyTexSubImage2D cullFace deleteBuffer deleteFramebuffer deleteProgram deleteRenderbuffer deleteShader deleteTexture detachShader " +
        "depthFunc depthMask depthRange disable enable enableVertexAttribArray framebufferRenderbuffer framebufferTexture2D frontFace generateMipmap getAttribLocation getExtension getUniformLocation " +
        "hint lineWidth linkProgram pixelStorei polygonOffset scissor shaderSource stencilFunc stencilFuncSeparate stencilMask " +
        "stencilOp stencilOpSeparate texParameterf texParameteri uniform1f uniform1fv uniform1i uniform1iv uniform2f uniform2fv uniform2i uniform2iv " +
        "uniform3f uniform3fv uniform3i uniform3iv uniform4f uniform4fv uniform4i uniform4iv uniformMatrix2fv uniformMatrix3fv uniformMatrix4fv " +
        "renderbufferStorage sampleCoverage stencilMaskSeparate texImage2D texSubImage2D useProgram validateProgram vertexAttrib1f vertexAttrib1fv vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv " +
        "vertexAttribPointer viewport drawArrays drawElements createBuffer createFramebuffer createProgram createRenderbuffer createShader createTexture " +
        "bindBufferBase bindBufferRange bindVertexArray blitFramebuffer clearBufferfi clearBufferfv clearBufferiv clearBufferuiv copyTexSubImage3D " +
        "createVertexArray deleteVertexArray drawArraysInstanced drawElementsInstanced drawRangeElements framebufferTextureLayer readBuffer " +
        "renderbufferStorageMultisample texImage3D texStorage2D texStorage3D texSubImage3D vertexAttribDivisor drawBuffers samplerParameterf samplerParameteri bindSampler createSampler deleteSampler " +
        "bindTransformFeedback beginTransformFeedback endTransformFeedback createTransformFeedback deleteTransformFeedback pauseTransformFeedback resumeTransformFeedback getFragDataLocation " +
        "enableiOES disableiOES blendEquationiOES blendEquationSeparateiOES blendFunciOES blendFuncSeparateiOES colorMaskiOES " +
        "polygonModeWEBGL " +
        "createQuery deleteQuery beginQuery endQuery queryCounter getQuery getQueryParameter " +
        "copyBufferSubData invalidateFramebuffer invalidateSubFramebuffer compressedTexImage2D compressedTexSubImage2D compressedTexImage3D compressedTexSubImage3D " +
        "uniform1ui uniform1uiv uniform2ui uniform2uiv uniform3ui uniform3uiv uniform4ui uniform4uiv " +
        "uniformMatrix2x3fv uniformMatrix2x4fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4x2fv uniformMatrix4x3fv " +
        "uniformBlockBinding transformFeedbackVaryings vertexAttribIPointer vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv"
    ).split(/\s+/));
    const objectTypes = { createBuffer: "buffer", createFramebuffer: "framebuffer", createProgram: "program", createQuery: "query", createRenderbuffer: "renderbuffer", createSampler: "sampler", createShader: "shader", createTexture: "texture", createTransformFeedback: "transformfeedback", createVertexArray: "vertexarray" };
    const gl2OnlyMethods = new Set(["bindBufferBase", "bindBufferRange", "bindSampler", "bindTransformFeedback", "bindVertexArray", "beginQuery", "beginTransformFeedback", "blitFramebuffer", "clearBufferfi", "clearBufferfv", "clearBufferiv", "clearBufferuiv", "compressedTexImage3D", "compressedTexSubImage3D", "copyBufferSubData", "copyTexSubImage3D", "createQuery", "createSampler", "createTransformFeedback", "createVertexArray", "deleteQuery", "deleteSampler", "deleteTransformFeedback", "deleteVertexArray", "drawArraysInstanced", "drawBuffers", "drawElementsInstanced", "drawRangeElements", "endQuery", "endTransformFeedback", "framebufferTextureLayer", "getFragDataLocation", "getQuery", "getQueryParameter", "invalidateFramebuffer", "invalidateSubFramebuffer", "pauseTransformFeedback", "queryCounter", "readBuffer", "renderbufferStorageMultisample", "resumeTransformFeedback", "samplerParameterf", "samplerParameteri", "texImage3D", "texStorage2D", "texStorage3D", "texSubImage3D", "transformFeedbackVaryings", "uniform1ui", "uniform1uiv", "uniform2ui", "uniform2uiv", "uniform3ui", "uniform3uiv", "uniform4ui", "uniform4uiv", "uniformBlockBinding", "uniformMatrix2x3fv", "uniformMatrix2x4fv", "uniformMatrix3x2fv", "uniformMatrix3x4fv", "uniformMatrix4x2fv", "uniformMatrix4x3fv", "vertexAttribDivisor", "vertexAttribIPointer", "vertexAttribI4i", "vertexAttribI4iv", "vertexAttribI4ui", "vertexAttribI4uiv"]);
    const localQueryMethods = new Set(["beginQuery", "createQuery", "deleteQuery", "endQuery", "getQuery", "getQueryParameter", "queryCounter"]);
    const supportedExtensions = new Set(["OES_element_index_uint", "OES_standard_derivatives", "WEBGL_depth_texture", "OES_texture_float", "OES_texture_float_linear", "OES_texture_half_float", "OES_texture_half_float_linear", "EXT_color_buffer_float", "EXT_color_buffer_half_float", "EXT_float_blend", "OES_draw_buffers_indexed", "WEBGL_polygon_mode", "EXT_texture_filter_anisotropic", "EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2", "OES_vertex_array_object", "ANGLE_instanced_arrays", "WEBGL_draw_buffers", "WEBGL_multi_draw", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "WEBGL_compressed_texture_etc", "WEBGL_compressed_texture_etc1", "WEBGL_compressed_texture_pvrtc", "WEBGL_compressed_texture_atc", "WEBGL_compressed_texture_astc", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc"]);
    function extensionSupported(name, state) { return supportedExtensions.has(name) && (name !== "EXT_color_buffer_float" && name !== "OES_draw_buffers_indexed" || state.version === 2); }
    const skipQueries = new Set(["checkFramebufferStatus", "finish", "flush", "getContextAttributes", "getParameter", "getError", "getShaderParameter", "getProgramParameter", "getShaderInfoLog", "getProgramInfoLog", "getShaderSource", "getShaderPrecisionFormat", "getActiveAttrib", "getActiveUniform", "getActiveUniformBlockName", "getActiveUniformBlockParameter", "getActiveUniforms", "getAttachedShaders", "getBufferParameter", "getBufferSubData", "getFragDataLocation", "getFramebufferAttachmentParameter", "getIndexedParameter", "getInternalformatParameter", "getQueryParameter", "getRenderbufferParameter", "getSamplerParameter", "getSyncParameter", "getTexParameter", "getTransformFeedbackVarying", "getUniform", "getUniformBlockIndex", "getUniformIndices", "getSupportedExtensions", "getVertexAttrib", "getVertexAttribOffset", "isBuffer", "isContextLost", "isEnabled", "isFramebuffer", "isProgram", "isQuery", "isRenderbuffer", "isSampler", "isShader", "isSync", "isTexture", "isTransformFeedback", "isVertexArray", "readPixels"]);
    const locationMethods = new Set(["enableVertexAttribArray", "disableVertexAttribArray", "vertexAttribDivisor", "vertexAttribPointer", "vertexAttribIPointer", "vertexAttribI4i", "vertexAttribI4iv", "vertexAttribI4ui", "vertexAttribI4uiv", "vertexAttrib1f", "vertexAttrib1fv", "vertexAttrib2f", "vertexAttrib2fv", "vertexAttrib3f", "vertexAttrib3fv", "vertexAttrib4f", "vertexAttrib4fv"]);
    const drawMethods = new Set(["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]);
    const frameWrites = new Set(["clear", "clearBufferfi", "clearBufferfv", "clearBufferiv", "clearBufferuiv", ...drawMethods]);
    const compactStateMethods = new Set(["clearColor", "clearDepth", "clearStencil", "colorMask", "depthMask", "depthFunc", "depthRange", "blendColor", "blendEquation", "blendEquationSeparate", "blendFunc", "blendFuncSeparate", "cullFace", "frontFace", "lineWidth", "polygonOffset", "polygonModeWEBGL", "sampleCoverage", "scissor", "viewport", "stencilFunc", "stencilFuncSeparate", "stencilMask", "stencilMaskSeparate", "stencilOp", "stencilOpSeparate", "drawBuffers", "enable", "disable", ...locationMethods]);
    let nextContext = 0;

    function signal(canvas, name) {
        try { apply(originalDispatch, canvas, [new EventCtor(name, { bubbles: true })]); } catch { /* detached canvas */ }
        // In a same-origin frame, told on its iframe too, where the page's
        // agent hears it (it doesn't hear the frame's own events in Moli).
        try {
            const owner = globalThis.frameElement;
            if (owner && canvas.ownerDocument === document) {
                const index = Array.prototype.indexOf.call(document.querySelectorAll("canvas"), canvas);
                if (index >= 0) apply(originalDispatch, owner, [new CustomEventCtor("__tabtop_frame_canvas_dirty", { bubbles: true, detail: JSON.stringify({ index }) })]);
            }
        } catch { /* another origin's frame, or gone */ }
    }
    function unsupported(state, reason = "unsupported") {
        if (state.bad) return;
        state.bad = true;
        signal(state.canvas, "__tabtop_webgl_dirty");
    }
    function encode(state, value, bytes) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "object") {
            const objectID = state.objects.get(value);
            if (objectID) return { ref: objectID };
            if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
                const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                bytes.n += view.byteLength;
                if (bytes.n > maxData) throw new Error("data limit");
                let binary = "";
                for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
                return { typed: value.constructor.name, data: btoa(binary) };
            }
            if (value instanceof ArrayBuffer) {
                const view = new Uint8Array(value);
                bytes.n += view.byteLength;
                if (bytes.n > maxData) throw new Error("data limit");
                let binary = "";
                for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
                return { typed: "Uint8Array", data: btoa(binary) };
            }
            if (Array.isArray(value) && value.length <= 64) return value.map((v) => encode(state, v, bytes));
        }
        throw new Error("unsupported argument");
    }
    function encodeTextureSource(state, source, bytes) {
        let width = 0, height = 0, pixels;
        if (typeof ImageData !== "undefined" && source instanceof ImageData) {
            width = source.width;
            height = source.height;
            pixels = source.data;
        } else {
            width = source.naturalWidth || source.videoWidth || source.width || 0;
            height = source.naturalHeight || source.videoHeight || source.height || 0;
            if (!width || !height || width > 4096 || height > 4096 || width * height > (16 << 20) || width * height * 4 > maxData) throw new Error("texture dimensions");
            const scratch = document.createElement("canvas");
            scratch.width = width;
            scratch.height = height;
            const ctx = scratch.getContext("2d");
            if (!ctx) throw new Error("texture readback unavailable");
            ctx.drawImage(source, 0, 0, width, height);
            pixels = ctx.getImageData(0, 0, width, height).data;
        }
        if (!width || !height || width > 4096 || height > 4096 || width * height > (16 << 20) || pixels.byteLength !== width * height * 4) throw new Error("texture dimensions");
        return { pixels: encode(state, pixels, bytes), width, height };
    }
    function record(state, method, args, result, bytes) {
        if (state.bad) return;
        if (localQueryMethods.has(method)) {
            if (method === "createQuery" && result && typeof result === "object") state.objectKinds.set(result, "query");
            else if (method === "deleteQuery" && args[0] && typeof args[0] === "object") state.objectKinds.delete(args[0]);
            return;
        }
        if (!allowed.has(method)) return unsupported(state, `method:${method}`);
        if (method === "useProgram") return;
        if (method === "getExtension" && args[0] === "WEBGL_multi_draw") {
            state.multiDrawRequested = true;
            if (state.drawIDShaders.size) return unsupported(state, "gl_DrawID multi-draw semantics");
        }
        if (method === "shaderSource" && typeof args[1] === "string" && /\bgl_DrawID\b/.test(args[1])) {
            const shader = state.objects.get(args[0]);
            if (shader) state.drawIDShaders.add(shader);
            if (state.multiDrawRequested) return unsupported(state, "gl_DrawID multi-draw semantics");
        } else if (method === "shaderSource") {
            const shader = state.objects.get(args[0]);
            if (shader) state.drawIDShaders.delete(shader);
        }
        const framebuffer = state.objects.get(drawFramebuffer(state)) || 0;
        const clearMask = method === "clear" ? Number(args[0]) : 0;
        if (method === "clear" && checkpointableClear(state, framebuffer, clearMask) && (state.commands.length >= maxCommands * 0.75 || state.bytes >= maxJSON * 0.75)) compactFramebufferFrames(state, framebuffer);
        if (state.commands.length >= maxCommands) return unsupported(state, `limit:${method}`);
        try {
            const a = Array.from(args, (v, i) => {
                if ((method === "texImage2D" || method === "texSubImage2D" || method === "texImage3D" || method === "texSubImage3D") && i === args.length - 1 && v && typeof v === "object" && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer)) {
                    return encodeTextureSource(state, v, bytes);
                }
                if (method === "getUniformLocation" && i === 0) return encode(state, v, bytes);
                if (method === "getAttribLocation" && i === 0) return encode(state, v, bytes);
                if (locationMethods.has(method) && i === 0 && Number.isInteger(v)) {
                    const location = state.locations.get(`${state.currentProgram || 0}:${v}`);
                    return location ? { location: location.name, program: location.program } : v;
                }
                return encode(state, v, bytes);
            });
            const command = { m: method, a };
            if (drawMethods.has(method) || method === "clear" || method.startsWith("clearBuffer")) {
                const framebuffer = state.objects.get(drawFramebuffer(state)) || 0;
                command.fb = framebuffer;
                if (drawMethods.has(method)) {
                    const program = state.currentProgram || 0;
                    command.pr = program;
                }
            } else if (method.startsWith("uniform") && state.locationPrograms.has(args[0])) {
                command.up = state.locationPrograms.get(args[0]);
            } else if (method.startsWith("copyTex")) {
                // The framebuffer it reads (compactFramebufferFrames); not
                // in the log (its fields are checked: goCanvasGLKeys).
                copyReads.set(command, state.objects.get(readFramebuffer(state)) || 0);
            }
            if (result && typeof result === "object") {
                const id = ++state.nextObject;
                state.objects.set(result, id);
                state.objectKinds.set(result, method === "getUniformLocation" ? "uniform" : objectTypes[method] || "object");
                if (method === "getUniformLocation") {
                    const program = state.objects.get(args[0]);
                    if (program) state.locationPrograms.set(result, program);
                }
                command.r = id;
                command.rt = method === "getUniformLocation" ? "uniform" : objectTypes[method];
            } else if (method === "getAttribLocation" && Number.isInteger(result) && result >= 0 && typeof args[1] === "string") {
                const program = state.objects.get(args[0]);
                if (program) {
                    command.q = result;
                    command.program = program;
                    command.name = args[1];
                    state.locations.set(`${program}:${result}`, { program, name: args[1] });
                }
            }
            const commandBytes = JSON.stringify(command).length;
            if (state.bytes + commandBytes > maxJSON) return unsupported(state, `bytes:${method}`);
            state.commands.push(command);
            if (method.startsWith("delete") && args[0] && typeof args[0] === "object") {
                state.objects.delete(args[0]);
                state.objectKinds.delete(args[0]);
            }
            state.bytes += commandBytes;
            if (drawMethods.has(method)) {
                const dirty = state.framebufferDirty.get(framebuffer) || { depth: false, stencil: false };
                if (state.shadow.enabled.has(0x0B71) && state.shadow.depthMask) dirty.depth = true;
                if (state.shadow.enabled.has(0x0B90)) dirty.stencil = true;
                state.framebufferDirty.set(framebuffer, dirty);
            } else if (method === "clear") {
                const dirty = state.framebufferDirty.get(framebuffer) || { depth: false, stencil: false };
                if ((clearMask & 0x0100) !== 0 && state.shadow.depthMask) dirty.depth = false;
                if ((clearMask & 0x0400) !== 0 && stencilMaskFull(state.shadow)) dirty.stencil = false;
                state.framebufferDirty.set(framebuffer, dirty);
            }
            // A full replay log is sent only when dirty. This makes every
            // update self-contained and lets the viewer reset after gaps.
            if (drawMethods.has(method) || method === "blitFramebuffer" || method.startsWith("clearBuffer") || method === "clear" || method === "bufferData" || method === "bufferSubData" || method.startsWith("texImage") || method.startsWith("texSubImage") || method.startsWith("texStorage")) {
                signal(state.canvas, "__tabtop_webgl_dirty");
            }
        } catch (err) { unsupported(state, `${method}:${err?.message}`); }
    }
    function stencilMaskFull(shadow) {
        return ((shadow.stencilMasks?.front ?? 0xFFFFFFFF) & 0xFF) === 0xFF && ((shadow.stencilMasks?.back ?? 0xFFFFFFFF) & 0xFF) === 0xFF;
    }
    function checkpointableClear(state, framebuffer, mask) {
        if ((mask & 0x4000) === 0 || state.shadow.enabled.has(0x0C11) || !state.shadow.colorMask.every(Boolean)) return false;
        const dirty = state.framebufferDirty.get(framebuffer);
        if (dirty?.depth && ((mask & 0x0100) === 0 || !state.shadow.depthMask)) return false;
        if (dirty?.stencil && ((mask & 0x0400) === 0 || !stencilMaskFull(state.shadow))) return false;
        return true;
    }
    function compactFramebufferFrames(state, framebuffer) {
        if (state.commands.some((command) => command.m === "blitFramebuffer" || command.m === "drawBuffers" || command.m.endsWith("iOES"))) return;
        // A copy of this framebuffer into a texture (a feedback effect, a
        // trail) is of the draws that would go: not compacted (given up at
        // the log's limit, shown as unsupported, rather than wrong).
        if (state.commands.some((command) => command.m.startsWith("copyTex") && copyReads.get(command) === framebuffer)) return;
        const compactIndependentState = !state.commands.some((command) => frameWrites.has(command.m) && (command.fb || 0) !== framebuffer);
        const latest = new Map();
        const skip = new Set();
        const boundBuffers = new Map();
        const latestBufferData = new Map();
        const latestSubData = new Map();
        const bufferAt = new Map();
        const subDataKey = (command, buffer) => {
            const data = command.a?.[2];
            if (!data || typeof data !== "object" || typeof data.data !== "string" || typeof data.typed !== "string") return "";
            return `${buffer}:${command.a[1]}:${data.typed}:${data.data.length}:${command.a[3] ?? ""}:${command.a[4] ?? ""}`;
        };
        for (let i = 0; compactIndependentState && i < state.commands.length; i++) {
            const command = state.commands[i], target = command.a?.[0];
            if (command.m === "bindBuffer" && (target === 0x8892 || target === 0x8F37)) boundBuffers.set(target, command.a[1]?.ref || 0);
            if ((command.m === "bufferData" || command.m === "bufferSubData") && (target === 0x8892 || target === 0x8F37)) bufferAt.set(i, boundBuffers.get(target) || 0);
            const buffer = bufferAt.get(i);
            if (!buffer) continue;
            if (command.m === "bufferData") latestBufferData.set(buffer, i);
            if (command.m === "bufferSubData") {
                const key = subDataKey(command, buffer);
                if (key) latestSubData.set(key, i);
            }
        }
        for (const [i, buffer] of bufferAt) {
            const command = state.commands[i];
            if (command.m === "bufferData" && latestBufferData.get(buffer) !== i) skip.add(i);
            if (command.m === "bufferSubData") {
                const latestData = latestBufferData.get(buffer);
                if (latestData !== undefined && i < latestData) { skip.add(i); continue; }
                const key = subDataKey(command, buffer);
                if (key && latestSubData.get(key) !== i) skip.add(i);
            }
        }
        // A uniform's location by its name (a page may ask for it again each
        // frame, a new object each time: the same uniform).
        const locationNames = new Map();
        for (const command of state.commands) if (command.m === "getUniformLocation" && command.r && typeof command.a?.[1] === "string") locationNames.set(command.r, command.a[1]);
        const keyOf = (command, vertexArray) => {
            const method = command.m, first = command.a?.[0];
            if (method === "enable" || method === "disable") return `cap:${JSON.stringify(first)}`;
            if (method === "stencilFuncSeparate" || method === "stencilMaskSeparate" || method === "stencilOpSeparate") return `state:${method}:${JSON.stringify(first)}`;
            if (method.startsWith("uniform") && command.up > 0) return `uniform:${command.up}:${locationNames.has(first?.ref) ? "name:" + locationNames.get(first.ref) : JSON.stringify(first)}`;
            if (locationMethods.has(method)) return `attrib:${vertexArray}:${method}:${JSON.stringify(first)}`;
            return compactStateMethods.has(method) ? `state:${method}` : "";
        };
        const kept = [];
        let vertexArray = 0;
        for (let i = 0; i < state.commands.length; i++) {
            const command = state.commands[i];
            if (skip.has(i)) continue;
            if (command.m === "bindVertexArray") vertexArray = command.a?.[0]?.ref || 0;
            if (frameWrites.has(command.m) && (command.fb || 0) === framebuffer) continue;
            const key = compactIndependentState ? keyOf(command, vertexArray) : "";
            if (key) {
                const old = latest.get(key);
                if (old !== undefined) kept[old] = null;
                latest.set(key, kept.length);
            }
            kept.push(command);
        }
        state.commands = kept.filter(Boolean);
        if (compactIndependentState) state.commands = compactBinds(state.commands);
        state.bytes = state.commands.reduce((sum, command) => sum + JSON.stringify(command).length, 0);
        state.cursor = 0;
        state.forceFull = true;
    }
    // compactBinds drops the binds nothing kept after them may use: each
    // kind's last is kept (the state the log leaves), and one before
    // anything that may use what's bound (an upload, a create, a draw of
    // another target's: any call but another bind). A location asked for
    // again, nothing kept naming the one before, goes too.
    function compactBinds(commands) {
        const keys = new Array(commands.length).fill("");
        let unit = 0x84C0, vertexArray = 0;
        for (let i = 0; i < commands.length; i++) {
            const c = commands[i], target = c.a?.[0];
            switch (c.m) {
                case "activeTexture": keys[i] = "active"; unit = target; break;
                case "bindTexture": keys[i] = `texture:${unit}:${target}`; break;
                case "bindBuffer": keys[i] = target === 0x8893 ? `buffer:${vertexArray}:${target}` : `buffer:${target}`; break;
                case "bindVertexArray": case "bindVertexArrayOES": keys[i] = "vertexArray"; vertexArray = target?.ref || 0; break;
                case "bindRenderbuffer": keys[i] = `renderbuffer:${target}`; break;
                case "bindSampler": keys[i] = `sampler:${target}`; break;
                case "pixelStorei": keys[i] = `pixel:${target}`; break;
            }
        }
        const all = new Set(keys.filter(Boolean));
        const needed = new Set(all);
        const keep = new Array(commands.length).fill(true);
        for (let i = commands.length - 1; i >= 0; i--) {
            const key = keys[i];
            if (!key) {
                for (const k of all) needed.add(k);
                continue;
            }
            if (!needed.has(key)) { keep[i] = false; continue; }
            needed.delete(key);
            if (key.startsWith("texture:")) needed.add("active");
            if (key.startsWith("buffer:") && key.split(":").length === 3) needed.add("vertexArray");
        }
        let out = commands.filter((_, i) => keep[i]);
        // Locations asked for again: the earlier, named by nothing kept, go.
        const named = new Set();
        const refs = (v) => {
            if (Array.isArray(v)) v.forEach(refs);
            else if (v && typeof v === "object") {
                if (Number.isInteger(v.ref)) named.add(v.ref);
                else for (const x of Object.values(v)) refs(x);
            }
        };
        for (const c of out) if (c.m !== "getUniformLocation") refs(c.a);
        const lastAsked = new Map();
        out.forEach((c, i) => { if (c.m === "getUniformLocation") lastAsked.set(JSON.stringify(c.a), i); });
        out = out.filter((c, i) => c.m !== "getUniformLocation" || named.has(c.r) || lastAsked.get(JSON.stringify(c.a)) === i);
        return out;
    }
    function contextAttributeMask(gl) {
        let attributes = null;
        try { attributes = gl.getContextAttributes(); } catch { /* use WebGL defaults */ }
        attributes ||= { alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
        return (attributes.alpha ? 1 : 0) | (attributes.depth ? 2 : 0) | (attributes.stencil ? 4 : 0) | (attributes.antialias ? 8 : 0) | (attributes.premultipliedAlpha ? 16 : 0) | (attributes.preserveDrawingBuffer ? 32 : 0);
    }
    function stateFor(canvas, gl, version = 1) {
        let state = contexts.get(gl);
        if (!state) {
            state = { canvas, gl, id: ++nextContext, version, attributes: contextAttributeMask(gl), objects: new WeakMap(), objectKinds: new WeakMap(), locationPrograms: new WeakMap(), framebufferDirty: new Map(), drawIDShaders: new Set(), nextObject: 0, locations: new Map(), currentProgram: 0, commands: [], cursor: 0, bytes: 0, bad: false, forceFull: true,
                shadow: { activeTexture: gl.TEXTURE0, buffers: new Map(), textures: new Map(), samplers: new Map(), pixelStore: new Map(), vertexArrayElementBuffers: new Map(), framebuffer: null, drawFramebuffer: null, readFramebuffer: null, renderbuffer: null, program: null, enabled: new Set(), viewport: [0, 0, canvas.width, canvas.height], clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0, colorMask: [true, true, true, true], depthMask: true, stencilMasks: { front: 0xFFFFFFFF, back: 0xFFFFFFFF } } };
            contexts.set(gl, state);
            contextByCanvas.set(canvas, state);
            canvas.addEventListener("webglcontextlost", (event) => {
                event.preventDefault();
                state.bad = true;
                signal(canvas, "__tabtop_webgl_dirty");
            });
            canvas.addEventListener("webglcontextrestored", () => {
                state.objects = new WeakMap();
                state.objectKinds = new WeakMap();
                state.locationPrograms = new WeakMap();
                state.nextObject = 0;
                state.locations.clear();
                state.currentProgram = 0;
                state.framebufferDirty = new Map();
                state.drawIDShaders = new Set();
                state.commands = [];
                state.cursor = 0;
                state.bytes = 0;
                state.forceFull = true;
                state.bad = false;
                state.shadow = { activeTexture: gl.TEXTURE0, buffers: new Map(), textures: new Map(), samplers: new Map(), pixelStore: new Map(), vertexArrayElementBuffers: new Map(), framebuffer: null, drawFramebuffer: null, readFramebuffer: null, renderbuffer: null, program: null, enabled: new Set(), viewport: [0, 0, canvas.width, canvas.height], clearColor: [0, 0, 0, 0], clearDepth: 1, clearStencil: 0, colorMask: [true, true, true, true], depthMask: true, stencilMasks: { front: 0xFFFFFFFF, back: 0xFFFFFFFF } };
                signal(canvas, "__tabtop_webgl_dirty");
            });
        }
        return state;
    }

    function fillEnums(gl, version = 1) {
        for (const [name, value] of Object.entries(version === 2 ? { ...enums, ...gl2Enums } : enums)) {
            if (typeof gl[name] === "number") continue;
            try { Object.defineProperty(gl, name, { value, configurable: true }); }
            catch { try { gl[name] = value; } catch { /* an engine may seal its context */ } }
        }
    }

    function missingResult(name, gl, args) {
        if (name.startsWith("create") && objectTypes[name]) return Object.create(null);
        if (name === "getError") return gl.NO_ERROR;
        if (name === "getParameter") {
            const version = contexts.get(gl)?.version ?? 1;
            switch (args[0]) {
                case gl.MAX_TEXTURE_SIZE: return 4096;
                case gl.MAX_CUBE_MAP_TEXTURE_SIZE: return 2048;
                case gl.MAX_RENDERBUFFER_SIZE: return 4096;
                case gl.MAX_VIEWPORT_DIMS: return new Int32Array([4096, 4096]);
                case gl.MAX_VERTEX_ATTRIBS: return version === 2 ? 16 : 8;
                case gl.MAX_VERTEX_UNIFORM_VECTORS: return version === 2 ? 256 : 128;
                case gl.MAX_FRAGMENT_UNIFORM_VECTORS: return version === 2 ? 224 : 16;
                case gl.MAX_VARYING_VECTORS: return version === 2 ? 15 : 8;
                case gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return version === 2 ? 32 : 8;
                case gl.MAX_TEXTURE_IMAGE_UNITS: return version === 2 ? 16 : 8;
                case gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS: return version === 2 ? 16 : 0;
                case gl.MAX_3D_TEXTURE_SIZE: return 256;
                case gl.MAX_ARRAY_TEXTURE_LAYERS: return 256;
                case gl.MAX_DRAW_BUFFERS: return 4;
                case gl.MAX_COLOR_ATTACHMENTS: return 4;
                case gl.MAX_SAMPLES: return 4;
                case gl.MAX_VERTEX_UNIFORM_BLOCKS: case gl.MAX_FRAGMENT_UNIFORM_BLOCKS: return 12;
                case gl.MAX_COMBINED_UNIFORM_BLOCKS: return 24;
                case gl.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
                case gl.MAX_UNIFORM_BLOCK_SIZE: return 16384;
                case gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT: return 256;
                case gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: return 4;
                case gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: return 64;
                case gl.MAX_VERTEX_UNIFORM_BLOCKS: case gl.MAX_FRAGMENT_UNIFORM_BLOCKS: return 12;
                case gl.MAX_COMBINED_UNIFORM_BLOCKS: return 24;
                case gl.MAX_UNIFORM_BUFFER_BINDINGS: return 24;
                case gl.MAX_UNIFORM_BLOCK_SIZE: return 16384;
                case gl.MAX_DRAW_BUFFERS: case gl.MAX_COLOR_ATTACHMENTS: return 4;
                case gl.MAX_VERTEX_OUTPUT_COMPONENTS: return 64;
                case gl.MAX_FRAGMENT_INPUT_COMPONENTS: return 60;
                case gl.MAX_VARYING_COMPONENTS: return 60;
                case gl.MAX_TEXTURE_MAX_ANISOTROPY_EXT: return 4;
                default: return null;
            }
        }
        return undefined;
    }
    function addExtensionConstants(extension, name, version = 1, state = null) {
        if (!extension) extension = Object.create(null);
        const values = name === "OES_texture_half_float" ? { HALF_FLOAT_OES: version === 2 ? 0x140B : 0x8D61 } :
            name === "EXT_color_buffer_half_float" ? { RGBA16F_EXT: 0x881A, RGB16F_EXT: 0x881B, FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT: 0x8211, UNSIGNED_NORMALIZED_EXT: 0x8C17 } :
            name === "WEBGL_depth_texture" ? { UNSIGNED_INT_24_8_WEBGL: 0x84FA } :
                name === "EXT_texture_filter_anisotropic" ? { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF } :
                    name === "OES_vertex_array_object" ? { VERTEX_ARRAY_BINDING_OES: 0x85B5 } :
            name === "WEBGL_draw_buffers" ? { DRAW_BUFFER0_WEBGL: 0x8825, MAX_DRAW_BUFFERS_WEBGL: 0x8824, MAX_COLOR_ATTACHMENTS_WEBGL: 0x8CDF } :
                name === "WEBGL_polygon_mode" ? { POLYGON_MODE_WEBGL: 0x0B40, POLYGON_OFFSET_LINE_WEBGL: 0x2A02, LINE_WEBGL: 0x1B01, FILL_WEBGL: 0x1B02 } :
                            name.startsWith("EXT_disjoint_timer_query") ? { TIME_ELAPSED_EXT: 0x88BF, TIMESTAMP_EXT: 0x8E28, GPU_DISJOINT_EXT: 0x8FBB, QUERY_COUNTER_BITS_EXT: 0x8864, CURRENT_QUERY_EXT: 0x8865, QUERY_RESULT_EXT: 0x8866, QUERY_RESULT_AVAILABLE_EXT: 0x8867 } :
                                name === "WEBGL_compressed_texture_s3tc" ? { COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83F0, COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83F1, COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83F2, COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83F3 } :
                                    name === "WEBGL_compressed_texture_s3tc_srgb" ? { COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8C4C, COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8C4D, COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8C4E, COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8C4F } :
                                        name === "WEBGL_compressed_texture_etc1" ? { COMPRESSED_RGB_ETC1_WEBGL: 0x8D64 } :
                                            name === "WEBGL_compressed_texture_etc" ? { COMPRESSED_R11_EAC: 0x9270, COMPRESSED_SIGNED_R11_EAC: 0x9271, COMPRESSED_RG11_EAC: 0x9272, COMPRESSED_SIGNED_RG11_EAC: 0x9273, COMPRESSED_RGB8_ETC2: 0x9274, COMPRESSED_SRGB8_ETC2: 0x9275, COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9276, COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2: 0x9277, COMPRESSED_RGBA8_ETC2_EAC: 0x9278, COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279 } :
                                                name === "WEBGL_compressed_texture_pvrtc" ? { COMPRESSED_RGB_PVRTC_4BPPV1_IMG: 0x8C00, COMPRESSED_RGB_PVRTC_2BPPV1_IMG: 0x8C01, COMPRESSED_RGBA_PVRTC_4BPPV1_IMG: 0x8C02, COMPRESSED_RGBA_PVRTC_2BPPV1_IMG: 0x8C03 } :
                                                    name === "WEBGL_compressed_texture_atc" ? { COMPRESSED_RGB_ATC_WEBGL: 0x8C92, COMPRESSED_RGBA_ATC_EXPLICIT_ALPHA_WEBGL: 0x8C93, COMPRESSED_RGBA_ATC_INTERPOLATED_ALPHA_WEBGL: 0x87EE } :
                                                        name === "EXT_texture_compression_bptc" ? { COMPRESSED_RGBA_BPTC_UNORM_EXT: 0x8E8C, COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT: 0x8E8D, COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT: 0x8E8E, COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT: 0x8E8F } :
                                                            name === "EXT_texture_compression_rgtc" ? { COMPRESSED_RED_RGTC1_EXT: 0x8DBB, COMPRESSED_SIGNED_RED_RGTC1_EXT: 0x8DBC, COMPRESSED_RED_GREEN_RGTC2_EXT: 0x8DBD, COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT: 0x8DBE } : {};
        if (name === "WEBGL_compressed_texture_astc") {
            const blocks = ["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"];
            for (let i = 0; i < blocks.length; i++) { values[`COMPRESSED_RGBA_ASTC_${blocks[i]}_KHR`] = 0x93B0 + i; values[`COMPRESSED_SRGB8_ALPHA8_ASTC_${blocks[i]}_KHR`] = 0x93D0 + i; }
        }
        if (name === "WEBGL_draw_buffers") for (let i = 0; i < 16; i++) { values[`COLOR_ATTACHMENT${i}_WEBGL`] = 0x8CE0 + i; values[`DRAW_BUFFER${i}_WEBGL`] = 0x8825 + i; }
        for (const [key, value] of Object.entries(values)) {
            if (typeof extension[key] === "number") continue;
            try { Object.defineProperty(extension, key, { value, configurable: true }); } catch { /* native extension objects may be sealed */ }
        }
        const aliases = name === "OES_vertex_array_object" ? { createVertexArrayOES: "createVertexArray", deleteVertexArrayOES: "deleteVertexArray", bindVertexArrayOES: "bindVertexArray" } :
            name === "ANGLE_instanced_arrays" ? { drawArraysInstancedANGLE: "drawArraysInstanced", drawElementsInstancedANGLE: "drawElementsInstanced", vertexAttribDivisorANGLE: "vertexAttribDivisor" } :
                name === "WEBGL_draw_buffers" ? { drawBuffersWEBGL: "drawBuffers" } :
                    name === "WEBGL_polygon_mode" ? { polygonModeWEBGL: "polygonModeWEBGL" } :
                    name === "OES_draw_buffers_indexed" ? { enableiOES: "enableiOES", disableiOES: "disableiOES", blendEquationiOES: "blendEquationiOES", blendEquationSeparateiOES: "blendEquationSeparateiOES", blendFunciOES: "blendFunciOES", blendFuncSeparateiOES: "blendFuncSeparateiOES", colorMaskiOES: "colorMaskiOES" } : {};
        return new Proxy(extension, { get(target, property) {
            const multiMethod = name === "WEBGL_multi_draw" && typeof property === "string" ? property : "";
            if (["multiDrawArraysWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"].includes(multiMethod)) {
                const original = Reflect.get(target, property, target);
                return (...args) => {
                    const result = typeof original === "function" ? apply(original, target, args) : undefined;
                    if (!state) return result;
                    const drawCount = args[args.length - 1];
                    if (!Number.isInteger(drawCount) || drawCount < 0 || drawCount > maxCommands || state.commands.length + drawCount > maxCommands) { unsupported(state, "multi-draw count"); return result; }
                    const at = (list, offset, index) => {
                        if (!(Array.isArray(list) || ArrayBuffer.isView(list) && !(list instanceof DataView)) || !Number.isSafeInteger(offset) || offset < 0 || offset + drawCount > list.length) throw new Error("invalid multi-draw list");
                        const value = list?.[offset + index];
                        if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid multi-draw value");
                        return value;
                    };
                    try {
                        for (let i = 0; i < drawCount; i++) {
                            let method, values;
                            if (multiMethod === "multiDrawArraysWEBGL") {
                                method = "drawArrays";
                                values = [args[0], at(args[1], args[2], i), at(args[3], args[4], i)];
                            } else if (multiMethod === "multiDrawElementsWEBGL") {
                                method = "drawElements";
                                values = [args[0], at(args[1], args[2], i), args[3], at(args[4], args[5], i)];
                            } else if (multiMethod === "multiDrawArraysInstancedWEBGL") {
                                method = "drawArraysInstanced";
                                values = [args[0], at(args[1], args[2], i), at(args[3], args[4], i), at(args[5], args[6], i)];
                            } else {
                                method = "drawElementsInstanced";
                                values = [args[0], at(args[1], args[2], i), args[3], at(args[4], args[5], i), at(args[6], args[7], i)];
                            }
                            record(state, method, values, undefined, { n: 0 });
                        }
                    } catch { unsupported(state, "multi-draw arguments"); }
                    return result;
                };
            }
            const method = typeof property === "string" ? aliases[property] : undefined;
            if (!method) {
                const value = Reflect.get(target, property, target);
                if (name.startsWith("EXT_disjoint_timer_query") && typeof property === "string" && property.endsWith("EXT")) {
                    if (typeof value === "function") return value.bind(target);
                    if (["createQueryEXT", "deleteQueryEXT", "beginQueryEXT", "endQueryEXT", "queryCounterEXT", "getQueryEXT", "getQueryObjectEXT"].includes(property)) return (...args) => {
                        if (property === "createQueryEXT") return Object.create(null);
                        if (property === "getQueryEXT") return null;
                        if (property === "getQueryObjectEXT") return args[1] === 0x8867 ? true : 0;
                    };
                }
                return typeof value === "function" ? value.bind(target) : value;
            }
            const original = Reflect.get(target, property, target);
            return (...args) => {
                const result = typeof original === "function" ? apply(original, target, args) : missingResult(method, state?.gl, args);
                reflectTrack(method, args, result);
                if (state) { trackState(state, method, args); record(state, method, args, result, { n: 0 }); }
                return result;
            };
        } });
    }

    function trackState(state, method, args) {
        const s = state.shadow;
        switch (method) {
            case "activeTexture": s.activeTexture = args[0]; break;
            case "pixelStorei": s.pixelStore.set(args[0], args[1]); break;
            case "bindBuffer":
                s.buffers.set(args[0], args[1] ?? null);
                if (args[0] === 0x8893) s.vertexArrayElementBuffers.set(state.objects.get(s.vertexArray) || 0, args[1] ?? null);
                break;
            case "bindBufferBase": case "bindBufferRange": s.buffers.set(args[0], args[2] ?? null); break;
            case "bindTexture": s.textures.set(`${s.activeTexture}:${args[0]}`, args[1] ?? null); break;
            case "bindSampler": s.samplers.set(args[0], args[1] ?? null); break;
            case "bindFramebuffer":
                if (args[0] === 0x8CA8) s.readFramebuffer = args[1] ?? null;
                else {
                    s.framebuffer = args[1] ?? null;
                    s.drawFramebuffer = args[1] ?? null;
                    if (args[0] === 0x8D40) s.readFramebuffer = args[1] ?? null;
                }
                break;
            case "bindVertexArray":
                s.vertexArray = args[0] ?? null;
                s.buffers.set(0x8893, s.vertexArrayElementBuffers.get(state.objects.get(s.vertexArray) || 0) ?? null);
                break;
            case "deleteVertexArray": {
                const id = state.objects.get(args[0]) || 0;
                s.vertexArrayElementBuffers.delete(id);
                if (s.vertexArray === args[0]) {
                    s.vertexArray = null;
                    s.buffers.set(0x8893, s.vertexArrayElementBuffers.get(0) ?? null);
                }
                break;
            }
            case "bindRenderbuffer": s.renderbuffer = args[1] ?? null; break;
            case "useProgram": s.program = args[0] ?? null; state.currentProgram = state.objects.get(args[0]) || 0; break;
            case "viewport": s.viewport = args.slice(0, 4); break;
            case "scissor": s.scissor = args.slice(0, 4); break;
            case "clearColor": s.clearColor = args.slice(0, 4); break;
            case "clearDepth": s.clearDepth = args[0]; break;
            case "clearStencil": s.clearStencil = args[0]; break;
            case "colorMask": s.colorMask = args.slice(0, 4); break;
            case "depthMask": s.depthMask = args[0]; break;
            case "depthFunc": s.depthFunc = args[0]; break;
            case "stencilMask": s.stencilMasks = { front: args[0] >>> 0, back: args[0] >>> 0 }; break;
            case "stencilMaskSeparate":
                if (!s.stencilMasks) s.stencilMasks = { front: 0xFFFFFFFF, back: 0xFFFFFFFF };
                if (args[0] === 0x0404 || args[0] === 0x0408) s.stencilMasks.front = args[1] >>> 0;
                if (args[0] === 0x0405 || args[0] === 0x0408) s.stencilMasks.back = args[1] >>> 0;
                break;
            case "blendColor": s.blendColor = args.slice(0, 4); break;
            case "cullFace": s.cullFace = args[0]; break;
            case "frontFace": s.frontFace = args[0]; break;
            case "lineWidth": s.lineWidth = args[0]; break;
            case "enable": s.enabled.add(args[0]); break;
            case "disable": s.enabled.delete(args[0]); break;
        }
    }

    function drawFramebuffer(state) {
        return state.version === 2 ? state.shadow.drawFramebuffer ?? null : state.shadow.framebuffer;
    }
    const copyReads = new WeakMap();  // a copyTex* command -> the framebuffer it read
    function readFramebuffer(state) {
        return state.version === 2 ? state.shadow.readFramebuffer ?? null : state.shadow.framebuffer;
    }

    function shadowParameter(state, gl, parameter) {
        const s = state?.shadow;
        if (!s) return undefined;
        switch (parameter) {
            case gl.ACTIVE_TEXTURE: return s.activeTexture;
            case gl.ARRAY_BUFFER_BINDING: return s.buffers.get(gl.ARRAY_BUFFER) ?? null;
            case gl.ELEMENT_ARRAY_BUFFER_BINDING: return s.buffers.get(gl.ELEMENT_ARRAY_BUFFER) ?? null;
            case gl.CURRENT_PROGRAM: return s.program;
            case gl.VERTEX_ARRAY_BINDING: return s.vertexArray ?? null;
            case gl.TEXTURE_BINDING_2D: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_2D}`) ?? null;
            case gl.TEXTURE_BINDING_CUBE_MAP: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_CUBE_MAP}`) ?? null;
            case gl.TEXTURE_BINDING_3D: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_3D}`) ?? null;
            case gl.TEXTURE_BINDING_2D_ARRAY: return s.textures.get(`${s.activeTexture}:${gl.TEXTURE_2D_ARRAY}`) ?? null;
            case gl.SAMPLER_BINDING: return s.samplers.get(s.activeTexture - gl.TEXTURE0) ?? null;
            case gl.UNIFORM_BUFFER_BINDING: return s.buffers.get(gl.UNIFORM_BUFFER) ?? null;
            case gl.FRAMEBUFFER_BINDING: return s.framebuffer;
            case gl.DRAW_FRAMEBUFFER_BINDING: return s.drawFramebuffer ?? s.framebuffer;
            case gl.READ_FRAMEBUFFER_BINDING: return s.readFramebuffer ?? s.framebuffer;
            case gl.RENDERBUFFER_BINDING: return s.renderbuffer;
            case gl.VIEWPORT: return new Int32Array(s.viewport);
            case gl.SCISSOR_BOX: return new Int32Array(s.scissor ?? [0, 0, state.canvas.width, state.canvas.height]);
            case gl.COLOR_CLEAR_VALUE: return new Float32Array(s.clearColor);
            case gl.DEPTH_CLEAR_VALUE: return s.clearDepth;
            case gl.STENCIL_CLEAR_VALUE: return s.clearStencil;
            case gl.COLOR_WRITEMASK: return s.colorMask;
            case gl.DEPTH_WRITEMASK: return s.depthMask;
            case gl.BLEND_COLOR: return new Float32Array(s.blendColor ?? [0, 0, 0, 0]);
            case gl.CULL_FACE_MODE: return s.cullFace ?? gl.BACK;
            case gl.FRONT_FACE: return s.frontFace ?? gl.CCW;
            case gl.LINE_WIDTH: return s.lineWidth ?? 1;
            case gl.DEPTH_FUNC: return s.depthFunc ?? gl.LESS;
            case gl.PACK_ALIGNMENT: case gl.UNPACK_ALIGNMENT: return s.pixelStore.get(parameter) ?? 4;
            case gl.UNPACK_FLIP_Y_WEBGL: case gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return s.pixelStore.get(parameter) ?? false;
            case gl.UNPACK_COLORSPACE_CONVERSION_WEBGL: return s.pixelStore.get(parameter) ?? gl.BROWSER_DEFAULT_WEBGL;
            case 0x0D02: case 0x0D03: case 0x0D04: case 0x0CF2: case 0x0CF3: case 0x0CF4: case 0x806D: case 0x806E:
                return state.version === 2 ? s.pixelStore.get(parameter) ?? 0 : undefined;
            default: return undefined;
        }
    }

    Canvas.prototype.getContext = function (type, ...args) {
        const result = apply(originalGetContext, this, [type, ...args]);
        const kind = String(type).toLowerCase();
        if (result && (kind === "webgl" || kind === "experimental-webgl") && result instanceof GL) {
            fillEnums(result, 1);
            stateFor(this, result, 1);
        }
        else if (result && kind === "webgl2" && GL2 && result instanceof GL2) {
            fillEnums(result, 2);
            stateFor(this, result, 2);
        }
        return result;
    };

    for (const name of allowed) {
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        if (typeof descriptor?.value !== "function") {
            if (gl2OnlyMethods.has(name)) continue;
            Object.defineProperty(GL.prototype, name, { configurable: true, writable: true, value: function (...args) {
                const state = contexts.get(this);
                let result = missingResult(name, this, args);
                if (name === "getExtension" && state) {
                    if (!extensionSupported(args[0], state)) return null;
                    result = addExtensionConstants(null, args[0], state.version, state);
                }
                reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                return result;
            } });
            continue;
        }
        const original = descriptor.value;
        Object.defineProperty(GL.prototype, name, { ...descriptor, value: function (...args) {
            let result = apply(original, this, args);
            const state = contexts.get(this);
            if (name === "getExtension" && state) {
                if (!extensionSupported(args[0], state)) return null;
                result = addExtensionConstants(result, args[0], state.version, state);
            }
            reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
            return result;
        } });
    }
    for (const [name, fallback] of [
        ["getParameter", function (args) { return missingResult("getParameter", this, args); }],
        ["getError", function () { return this.NO_ERROR; }],
        ["checkFramebufferStatus", function () { return this.FRAMEBUFFER_COMPLETE; }],
        ["getShaderParameter", function (args) { return args[1] === this.COMPILE_STATUS ? true : null; }],
        ["getProgramParameter", function (args) { return args[1] === this.LINK_STATUS ? true : null; }],
        ["getShaderPrecisionFormat", function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; }],
        ["getContextAttributes", function () { return { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false }; }],
        ["getShaderInfoLog", function () { return ""; }],
        ["getProgramInfoLog", function () { return ""; }],
        ["getSupportedExtensions", function () { return []; }],
        ["getQuery", function () { return null; }],
        ["getQueryParameter", function (args) { return args[1] === this.QUERY_RESULT_AVAILABLE ? true : 0; }],
        ["isBuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "buffer"; }],
        ["isContextLost", function () { return false; }],
        ["isEnabled", function (args) { return contexts.get(this)?.shadow.enabled.has(args[0]) ?? false; }],
        ["isTexture", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "texture"; }],
        ["isFramebuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "framebuffer"; }],
        ["isRenderbuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "renderbuffer"; }],
        ["isSampler", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "sampler"; }],
        ["isProgram", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "program"; }],
        ["isShader", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "shader"; }],
    ]) {
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        const original = typeof descriptor?.value === "function" ? descriptor.value : null;
        Object.defineProperty(GL.prototype, name, { ...(descriptor ?? {}), configurable: true, writable: true, value: function (...args) {
            const state = contexts.get(this);
            const kind = name.slice(2).toLowerCase();
            if (name.startsWith("is") && state?.objectKinds.get(args[0]) === kind) return true;
            if (name === "isEnabled" && state) return state.shadow.enabled.has(args[0]);
            if (name === "getParameter") {
                // Fixed strings so detectors see a stable WebKit-like GPU identity
                // (Moli often returns nothing → "Unknown").
                if (args[0] === this.VENDOR) return "WebKit";
                if (args[0] === this.RENDERER) return "WebKit WebGL";
            }
            let result = original ? apply(original, this, args) : null;
            if (name === "getSupportedExtensions") return [...supportedExtensions].filter((extension) => extensionSupported(extension, state));
            if (name === "getParameter" && result == null) result = shadowParameter(state, this, args[0]);
            return result == null ? fallback.call(this, args) : result;
        } });
    }
    // Unknown WebGL calls make the mirror visibly incomplete. Read-only
    // queries stay local to Moli; they do not affect viewer replay state.
    for (const name of Object.getOwnPropertyNames(GL.prototype)) {
        if (name === "constructor" || allowed.has(name) || skipQueries.has(name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(GL.prototype, name);
        if (typeof descriptor?.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(GL.prototype, name, { ...descriptor, value: function (...args) {
            const result = apply(original, this, args);
            const state = contexts.get(this);
            if (state) unsupported(state, `method:${name}`);
            return result;
        } });
    }

    // Moli models WebGL2 with a separate prototype rather than inheriting
    // WebGLRenderingContext, so install the same bounded recorder there and
    // fill missing core calls with compatibility shims.
    if (GL2 && GL2.prototype !== GL.prototype) {
        const proto = GL2.prototype;
        for (const name of allowed) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function") {
                if (name in proto) continue;
                Object.defineProperty(proto, name, { configurable: true, writable: true, value: function (...args) {
                    const state = contexts.get(this);
                    let result = missingResult(name, this, args);
                    if (name === "getExtension" && state) {
                        if (!extensionSupported(args[0], state)) return null;
                        result = addExtensionConstants(null, args[0], state.version, state);
                    }
                    reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                    return result;
                } });
                continue;
            }
            const original = descriptor.value;
            Object.defineProperty(proto, name, { ...descriptor, value: function (...args) {
                let result = apply(original, this, args);
                const state = contexts.get(this);
                if (name === "getExtension" && state) {
                    if (!extensionSupported(args[0], state)) return null;
                    result = addExtensionConstants(result, args[0], state.version, state);
                }
                reflectTrack(name, args, result);
                if (state) { trackState(state, name, args); record(state, name, args, result, { n: 0 }); }
                return result;
            } });
        }
        for (const [name, fallback] of [
            ["getParameter", function (args) { return missingResult("getParameter", this, args); }],
            ["getError", function () { return this.NO_ERROR; }],
            ["checkFramebufferStatus", function () { return this.FRAMEBUFFER_COMPLETE; }],
            ["getShaderParameter", function (args) { return args[1] === this.COMPILE_STATUS ? true : null; }],
            ["getProgramParameter", function (args) { return args[1] === this.LINK_STATUS ? true : null; }],
            ["getShaderPrecisionFormat", function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; }],
            ["getContextAttributes", function () { return { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false }; }],
            ["getShaderInfoLog", function () { return ""; }], ["getProgramInfoLog", function () { return ""; }],
            ["getSupportedExtensions", function () { return []; }],
            ["getQuery", function () { return null; }],
            ["getQueryParameter", function (args) { return args[1] === this.QUERY_RESULT_AVAILABLE ? true : 0; }],
            ["isContextLost", function () { return false; }],
            ["isBuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "buffer"; }],
            ["isTexture", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "texture"; }],
            ["isFramebuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "framebuffer"; }],
            ["isRenderbuffer", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "renderbuffer"; }],
            ["isSampler", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "sampler"; }],
            ["isProgram", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "program"; }],
            ["isShader", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "shader"; }],
            ["isQuery", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "query"; }],
            ["isSync", function () { return false; }],
            ["isTransformFeedback", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "transformfeedback"; }],
            ["isVertexArray", function (args) { return contexts.get(this)?.objectKinds.get(args[0]) === "vertexarray"; }],
            ["isEnabled", function (args) { return contexts.get(this)?.shadow.enabled.has(args[0]) ?? false; }],
        ]) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function" && name in proto) continue;
            const original = typeof descriptor?.value === "function" ? descriptor.value : null;
            Object.defineProperty(proto, name, { ...(descriptor ?? {}), configurable: true, writable: true, value: function (...args) {
                const state = contexts.get(this);
                const kind = name.slice(2).toLowerCase();
                if (name.startsWith("is") && state?.objectKinds.get(args[0]) === kind) return true;
                if (name === "isEnabled" && state) return state.shadow.enabled.has(args[0]);
                if (name === "getParameter") {
                    if (args[0] === this.VENDOR) return "WebKit";
                    if (args[0] === this.RENDERER) return "WebKit WebGL";
                }
                let result = original ? apply(original, this, args) : null;
                if (name === "getSupportedExtensions") return [...supportedExtensions].filter((extension) => extensionSupported(extension, state));
                if (name === "getParameter" && result == null) result = shadowParameter(state, this, args[0]);
                return result == null ? fallback.call(this, args) : result;
            } });
        }
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === "constructor" || allowed.has(name) || skipQueries.has(name)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (typeof descriptor?.value !== "function") continue;
            const original = descriptor.value;
            Object.defineProperty(proto, name, { ...descriptor, value: function (...args) {
                const result = apply(original, this, args);
                const state = contexts.get(this);
                if (state) unsupported(state, `method:${name}`);
                return result;
            } });
        }
    }

    // Moli links programs without reflecting them: it has no
    // getActiveUniform or getActiveAttrib, which libraries such as three.js
    // use to find a program's uniforms and attributes. They're read from the
    // shaders' source instead: what's declared, after the preprocessor's
    // conditionals, is reported active. (A browser leaves out what a shader
    // doesn't use; the viewer replays calls on those as doing nothing.)
    const shaderInfo = new WeakMap();    // shader -> { type, source }
    const programShaders = new WeakMap(); // program -> Set of shaders
    const programInfo = new WeakMap();   // program -> { uniforms, attributes, locations }, as linked
    const programBindings = new WeakMap(); // program -> Map of attribute name -> location bound
    const glslTypes = {
        float: 0x1406, vec2: 0x8B50, vec3: 0x8B51, vec4: 0x8B52, int: 0x1404, ivec2: 0x8B53, ivec3: 0x8B54, ivec4: 0x8B55,
        bool: 0x8B56, bvec2: 0x8B57, bvec3: 0x8B58, bvec4: 0x8B59, mat2: 0x8B5A, mat3: 0x8B5B, mat4: 0x8B5C,
        uint: 0x1405, uvec2: 0x8DC6, uvec3: 0x8DC7, uvec4: 0x8DC8,
        mat2x2: 0x8B5A, mat3x3: 0x8B5B, mat4x4: 0x8B5C, mat2x3: 0x8B65, mat2x4: 0x8B66, mat3x2: 0x8B67, mat3x4: 0x8B68, mat4x2: 0x8B69, mat4x3: 0x8B6A,
        sampler2D: 0x8B5E, samplerCube: 0x8B60, sampler3D: 0x8B5F, sampler2DShadow: 0x8B62, sampler2DArray: 0x8DC1,
        sampler2DArrayShadow: 0x8DC4, samplerCubeShadow: 0x8DC5, isampler2D: 0x8DCA, isampler3D: 0x8DCB, isamplerCube: 0x8DCC,
        isampler2DArray: 0x8DCF, usampler2D: 0x8DD2, usampler3D: 0x8DD3, usamplerCube: 0x8DD4, usampler2DArray: 0x8DD7,
        samplerExternalOES: 0x8D66,
    };
    // glslValue evaluates a preprocessor expression (#if, an array's size):
    // integers, defined(), macros, and C's operators. Unknown names are 0.
    function glslValue(text, macros, depth = 0) {
        const tokens = String(text).match(/defined\s*\(\s*\w+\s*\)|defined\s+\w+|0[xX][0-9a-fA-F]+[uU]?|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?[uUfF]?|\w+|&&|\|\||<<|>>|<=|>=|==|!=|[-+*/%<>()!~&|^?:]/g) || [];
        let at = 0;
        const peek = () => tokens[at];
        const primary = () => {
            const t = tokens[at++];
            if (t === undefined) return 0;
            if (t === "(") { const v = ternary(); if (peek() === ")") at++; return v; }
            if (t === "!") return primary() ? 0 : 1;
            if (t === "-") return -primary();
            if (t === "+") return +primary();
            if (t === "~") return ~primary();
            if (t.startsWith("defined")) return macros.has(t.replace(/^defined\s*\(?\s*|\s*\)$/g, "").trim()) ? 1 : 0;
            if (/^[0-9]/.test(t)) return Number.parseFloat(t.startsWith("0x") || t.startsWith("0X") ? Number.parseInt(t, 16) : t) || 0;
            if (macros.has(t) && depth < 8) return glslValue(macros.get(t), macros, depth + 1);
            return 0;
        };
        const levels = [["*", "/", "%"], ["+", "-"], ["<<", ">>"], ["<", ">", "<=", ">="], ["==", "!="], ["&"], ["^"], ["|"], ["&&"], ["||"]];
        const binary = (level) => {
            if (level < 0) return primary();
            let v = binary(level - 1);
            while (levels[level].includes(peek())) {
                const op = tokens[at++], w = binary(level - 1);
                switch (op) {
                    case "*": v *= w; break; case "/": v = w ? Math.trunc(v / w) : 0; break; case "%": v = w ? v % w : 0; break;
                    case "+": v += w; break; case "-": v -= w; break; case "<<": v <<= w; break; case ">>": v >>= w; break;
                    case "<": v = +(v < w); break; case ">": v = +(v > w); break; case "<=": v = +(v <= w); break; case ">=": v = +(v >= w); break;
                    case "==": v = +(v === w); break; case "!=": v = +(v !== w); break; case "&": v &= w; break; case "^": v ^= w; break;
                    case "|": v |= w; break; case "&&": v = +(!!v && !!w); break; case "||": v = +(!!v || !!w); break;
                }
            }
            return v;
        };
        const ternary = () => {
            const c = binary(levels.length - 1);
            if (peek() !== "?") return c;
            at++;
            const a = ternary();
            if (peek() === ":") at++;
            const b = ternary();
            return c ? a : b;
        };
        try { return ternary(); } catch { return 0; }
    }
    // glslActive is a shader's source after its preprocessor: comments out,
    // conditionals taken, object-like macros kept for array sizes.
    function glslActive(source) {
        const text = String(source).slice(0, 1 << 20).replace(/\\\r?\n/g, "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
        const macros = new Map([["GL_ES", "1"], ["GL_FRAGMENT_PRECISION_HIGH", "1"]]);
        const out = [], stack = [];
        let on = true;
        for (const line of text.split("\n")) {
            const d = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
            if (!d) { if (on) out.push(line); continue; }
            const [, word, rest] = d;
            switch (word) {
                case "if": case "ifdef": case "ifndef": {
                    const name = rest.trim().split(/\s/)[0];
                    const v = word === "ifdef" ? macros.has(name) : word === "ifndef" ? !macros.has(name) : !!glslValue(rest, macros);
                    stack.push({ outer: on, taken: on && v });
                    on = on && v;
                    break;
                }
                case "elif": {
                    const top = stack.at(-1);
                    if (!top) break;
                    const v = top.outer && !top.taken && !!glslValue(rest, macros);
                    if (v) top.taken = true;
                    on = v;
                    break;
                }
                case "else": { const top = stack.at(-1); if (top) { on = top.outer && !top.taken; top.taken = true; } break; }
                case "endif": { const top = stack.pop(); on = top ? top.outer : true; break; }
                case "define": if (on) { const m = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest); if (m && !m[2]) macros.set(m[1], m[3].trim() || "1"); else if (m) macros.set(m[1], "1"); } break;
                case "undef": if (on) macros.delete(rest.trim()); break;
            }
        }
        return { text: out.join("\n"), macros, es3: /^\s*#\s*version\s+300\s+es/m.test(text) };
    }
    // glslDeclared lists a shader's uniforms (expanded to the names a
    // browser reports: arrays as name[0], structs field by field) and, for a
    // vertex shader, its attributes.
    function glslDeclared(source, vertex) {
        const { text, macros, es3 } = glslActive(source);
        const structs = new Map();
        const fields = (body) => {
            const list = [];
            for (const statement of body.split(";")) {
                const m = /^\s*(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\s\S]+)$/.exec(statement);
                if (!m) continue;
                for (const part of m[2].split(",")) {
                    const n = /^\s*(\w+)\s*(?:\[([^\]]*)\])?\s*$/.exec(part);
                    if (n) list.push({ type: m[1], name: n[1], size: n[2] === undefined ? 0 : Math.max(1, Math.min(4096, glslValue(n[2], macros) | 0)) });
                }
            }
            return list;
        };
        for (const m of text.matchAll(/\bstruct\s+(\w+)\s*\{([^{}]*)\}/g)) structs.set(m[1], fields(m[2]));
        let top = text;
        for (let i = 0; i < 16 && /\{[^{}]*\}/.test(top); i++) top = top.replace(/\{[^{}]*\}/g, " ; ");
        const uniforms = [], attributes = [];
        const expand = (type, name, size, depth = 0) => {
            if (uniforms.length >= 1024 || depth > 4) return;
            const struct = structs.get(type);
            if (!struct) {
                if (glslTypes[type] !== undefined) uniforms.push({ name: size ? `${name}[0]` : name, type: glslTypes[type], size: size || 1 });
                return;
            }
            for (let i = 0; i < (size || 1); i++) {
                for (const f of struct) expand(f.type, `${size ? `${name}[${i}]` : name}.${f.name}`, f.size, depth + 1);
            }
        };
        for (const statement of top.split(";")) {
            const m = /^\s*(?:layout\s*\(([^)]*)\)\s*)?(?:(?:flat|smooth|centroid|invariant|highp|mediump|lowp)\s+)*(uniform|attribute|in)\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([\s\S]+)$/.exec(statement);
            if (!m) continue;
            const [, layout, storage, type, names] = m;
            const at = /\blocation\s*=\s*(\d+)/.exec(layout ?? "");
            // A vertex shader's inputs: "attribute", or (GLSL ES 3) "in", which
            // three.js also writes as "attribute" with #define attribute in.
            if (storage !== "uniform" && (!vertex || (storage === "in" && !es3))) continue;
            for (const part of names.split(",")) {
                const n = /^\s*(\w+)\s*(?:\[([^\]]*)\])?\s*$/.exec(part);
                if (!n) continue;
                const size = n[2] === undefined ? 0 : Math.max(1, Math.min(4096, glslValue(n[2], macros) | 0));
                if (storage === "uniform") expand(type, n[1], size);
                else if (glslTypes[type] !== undefined && attributes.length < 64) attributes.push({ name: n[1], type: glslTypes[type], size: size || 1, layout: at ? Number(at[1]) : -1 });
            }
        }
        return { uniforms, attributes };
    }
    function reflectTrack(method, args, result) {
        try {
            switch (method) {
                case "createShader": if (result && typeof result === "object") shaderInfo.set(result, { type: args[0], source: "" }); break;
                case "shaderSource": { const info = shaderInfo.get(args[0]); if (info) info.source = String(args[1] ?? ""); break; }
                case "attachShader": {
                    if (!args[0] || typeof args[0] !== "object") break;
                    if (!programShaders.has(args[0])) programShaders.set(args[0], new Set());
                    programShaders.get(args[0]).add(args[1]);
                    break;
                }
                case "detachShader": programShaders.get(args[0])?.delete(args[1]); break;
                case "bindAttribLocation": {
                    if (!args[0] || typeof args[0] !== "object" || !Number.isInteger(args[1])) break;
                    if (!programBindings.has(args[0])) programBindings.set(args[0], new Map());
                    programBindings.get(args[0]).set(String(args[2]), args[1]);
                    break;
                }
                case "linkProgram": {
                    const uniforms = [], attributes = [], seen = new Set();
                    for (const shader of programShaders.get(args[0]) ?? []) {
                        const info = shaderInfo.get(shader);
                        if (!info) continue;
                        const declared = glslDeclared(info.source, info.type === 0x8B31);
                        for (const u of declared.uniforms) if (!seen.has(u.name)) { seen.add(u.name); uniforms.push(u); }
                        attributes.push(...declared.attributes);
                    }
                    // Where each attribute is: bound before linking, or as its
                    // layout says, or else the first free locations (a matrix
                    // takes one a column).
                    const bound = programBindings.get(args[0]) ?? new Map(), used = new Set();
                    const columns = { 0x8B5A: 2, 0x8B5B: 3, 0x8B5C: 4, 0x8B65: 2, 0x8B66: 2, 0x8B67: 3, 0x8B68: 3, 0x8B69: 4, 0x8B6A: 4 };
                    const take = (a, at) => { a.location = at; for (let i = 0; i < (columns[a.type] ?? 1) * a.size; i++) used.add(at + i); };
                    for (const a of attributes) if (bound.has(a.name)) take(a, bound.get(a.name)); else if (a.layout >= 0) take(a, a.layout);
                    for (const a of attributes) {
                        if (a.location !== undefined) continue;
                        const span = (columns[a.type] ?? 1) * a.size;
                        let at = 0;
                        while ([...Array(span).keys()].some((i) => used.has(at + i))) at++;
                        take(a, at);
                    }
                    programInfo.set(args[0], { uniforms, attributes: attributes.map(({ name, type, size }) => ({ name, type, size })), locations: new Map(attributes.map((a) => [a.name, a.location])) });
                    break;
                }
            }
        } catch { /* reflection is best effort; the program still links */ }
    }
    function activeInfo(entry) {
        if (!entry) return null;
        const Info = globalThis.WebGLActiveInfo;
        const info = Info ? Object.create(Info.prototype) : {};
        for (const [key, value] of Object.entries(entry)) Object.defineProperty(info, key, { value, enumerable: true });
        return info;
    }
    const reflectionShims = {
        getActiveUniform(program, index) { return activeInfo(programInfo.get(program)?.uniforms[index]); },
        getActiveAttrib(program, index) { return activeInfo(programInfo.get(program)?.attributes[index]); },
        getAttachedShaders(program) { return [...(programShaders.get(program) ?? [])]; },
        getShaderSource(shader) { return shaderInfo.get(shader)?.source ?? null; },
        disableVertexAttribArray() {},
        finish() {}, flush() {},
        getBufferParameter(target, pname) { return pname === 0x8765 ? 0x88E4 : 0; },
        getTexParameter() { return null; }, getUniform() { return null; }, getVertexAttrib() { return null; }, getVertexAttribOffset() { return 0; },
        getFramebufferAttachmentParameter() { return null; }, getRenderbufferParameter() { return null; },
        makeXRCompatible() { return Promise.resolve(); },
    };
    const reflectionShims2 = {
        getUniformBlockIndex() { return 0xFFFFFFFF; },
        getUniformIndices(program, names) { return Array.from(names ?? [], (name) => { const i = programInfo.get(program)?.uniforms.findIndex((u) => u.name === name || u.name === `${name}[0]`); return i >= 0 ? i : 0xFFFFFFFF; }); },
        getActiveUniforms(program, indices, pname) { return Array.from(indices ?? [], (i) => { const u = programInfo.get(program)?.uniforms[i]; return pname === 0x8A37 ? u?.type ?? 0 : pname === 0x8A38 ? u?.size ?? 0 : pname === 0x8A3A ? -1 : pname === 0x8A3E ? false : pname === 0x8A3B || pname === 0x8A3C || pname === 0x8A3D ? -1 : 0; }); },
        getActiveUniformBlockName() { return null; }, getActiveUniformBlockParameter() { return null; },
        getIndexedParameter() { return null; }, getSamplerParameter() { return null; }, getTransformFeedbackVarying() { return null; },
        getBufferSubData() {},
        fenceSync() { return Object.create(null); }, clientWaitSync() { return 0x911A; }, waitSync() {}, deleteSync() {},
        getSyncParameter(sync, pname) { return pname === 0x9114 ? 0x9119 : pname === 0x9112 ? 0x9116 : pname === 0x9113 ? 0x9117 : 0; },
    };
    for (const [proto, shims] of [[GL.prototype, reflectionShims], ...(GL2 ? [[GL2.prototype, { ...reflectionShims, ...reflectionShims2 }]] : [])]) {
        const reflected = typeof proto.getActiveUniform !== "function";
        for (const [name, fn] of Object.entries(shims)) {
            if (typeof proto[name] === "function") continue;
            try { Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn }); } catch { /* sealed */ }
        }
        if (!reflected) continue;
        // The counts libraries loop to come from the same reflection.
        const program = proto.getProgramParameter, shader = proto.getShaderParameter;
        Object.defineProperty(proto, "getProgramParameter", { configurable: true, writable: true, value: function (p, pname) {
            if (pname === 0x8B86) return programInfo.get(p)?.uniforms.length ?? 0;
            if (pname === 0x8B89) return programInfo.get(p)?.attributes.length ?? 0;
            if (pname === 0x8B85) return programShaders.get(p)?.size ?? 0;
            if (pname === 0x8A36) return 0;
            const result = typeof program === "function" ? apply(program, this, [p, pname]) : null;
            if (result != null) return result;
            return pname === 0x8B80 ? false : pname === 0x8B83 ? true : result;
        } });
        Object.defineProperty(proto, "getShaderParameter", { configurable: true, writable: true, value: function (s, pname) {
            if (pname === 0x8B4F) return shaderInfo.get(s)?.type ?? null;
            const result = typeof shader === "function" ? apply(shader, this, [s, pname]) : null;
            return result == null && pname === 0x8B80 ? false : result;
        } });
    }

    // The agent's reads of a same-origin frame's canvases, done here for it
    // (Moli doesn't take the agent's events to a frame's page): asked on the
    // iframe, the frame's canvas by its place among the frame's canvases;
    // the reply sent back on the iframe. (That it's drawn on, the frame's
    // own gogl.js tells on its iframe: signal.)
    globalThis.addEventListener("__tabtop_frame_canvas", (event) => {
        const frame = event.target;
        if (!(frame instanceof HTMLIFrameElement) || typeof event.detail !== "string" || event.detail.length > 256) return;
        let request, doc;
        try { request = JSON.parse(event.detail); doc = frame.contentDocument; } catch { return; }
        if (!doc || !Number.isInteger(request?.index) || !["__tabtop_webgl_capture", "__tabtop_webgl_undo", "__tabtop_canvas_capture"].includes(request.type)) return;
        const tellFrame = (type, detail) => { try { apply(originalDispatch, frame, [new CustomEventCtor(type, { bubbles: true, detail })]); } catch { /* gone */ } };
        const canvas = doc.querySelectorAll("canvas")[request.index];
        if (!canvas) return;
        let reply = null;
        const heard = (e) => { reply = e.detail; };
        canvas.addEventListener("__tabtop_canvas_pixels", heard);
        try { apply(originalDispatch, canvas, [new CustomEventCtor(request.type, { bubbles: true, detail: typeof request.detail === "string" ? request.detail : null })]); } catch { /* gone */ }
        canvas.removeEventListener("__tabtop_canvas_pixels", heard);
        if (typeof reply === "string") tellFrame("__tabtop_frame_canvas_reply", JSON.stringify({ index: request.index, reply }));
    }, true);

    // The agent couldn't send what it just read (its batch was full): read
    // it again next time, whole if it was meant to be whole.
    // On the window, not the document: a frame navigated from its first
    // (about:blank) document keeps its window, and this script isn't run again.
    globalThis.addEventListener("__tabtop_webgl_undo", (event) => {
        const state = event.target instanceof Canvas ? contextByCanvas.get(event.target) : null;
        if (!state?.undo) return;
        state.cursor = Math.min(state.undo.cursor, state.commands.length);
        state.forceFull = state.undo.forceFull || event.detail === "full";
        state.undo = null;
    }, true);
    globalThis.addEventListener("__tabtop_webgl_capture", (event) => {
        const canvas = event.target;
        if (!(canvas instanceof Canvas)) return;
        const state = contextByCanvas.get(canvas);
        if (!state) return;
        let result = { e: "unsupported" };
        if (state && canvas.width > 0 && canvas.height > 0 && canvas.width <= 4096 && canvas.height <= 4096 && canvas.width * canvas.height <= 16 * 1024 * 1024) {
            if (state.bad) result = { e: "unsupported" };
            else {
                try {
                    const full = event.detail === "full" || state.forceFull === true;
                    const g = JSON.stringify(full ? state.commands : state.commands.slice(state.cursor));
                    result = g.length <= maxJSON ? { g, w: canvas.width, h: canvas.height, c: state.id, r: full, version: state.version, attributes: state.attributes } : { e: "large" };
                    if (g.length <= maxJSON) {
                        state.undo = { cursor: state.cursor, forceFull: state.forceFull === true };
                        state.cursor = state.commands.length;
                        state.forceFull = false;
                    }
                } catch { result = { e: "unsupported" }; }
            }
        } else if (state) result = { e: "large" };
        try { apply(originalDispatch, canvas, [new CustomEventCtor("__tabtop_canvas_pixels", { bubbles: true, detail: JSON.stringify(result) })]); } catch { /* detached canvas */ }
    }, true);
})();
