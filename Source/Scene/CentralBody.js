/*global define*/
define([
        '../Core/DeveloperError',
        '../Core/RuntimeError',
        '../Core/Color',
        '../Core/combine',
        '../Core/destroyObject',
        '../Core/Math',
        '../Core/Intersect',
        '../Core/Occluder',
        '../Core/Ellipsoid',
        '../Core/Extent',
        '../Core/BoundingSphere',
        '../Core/BoundingRectangle',
        '../Core/Cache',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Cartographic',
        '../Core/Matrix3',
        '../Core/Matrix4',
        '../Core/Queue',
        '../Core/ComponentDatatype',
        '../Core/IndexDatatype',
        '../Core/MeshFilters',
        '../Core/PrimitiveType',
        '../Core/CubeMapEllipsoidTessellator',
        '../Core/ExtentTessellator',
        '../Core/PlaneTessellator',
        '../Core/JulianDate',
        '../Core/Transforms',
        '../Renderer/BufferUsage',
        '../Renderer/Command',
        '../Renderer/CommandLists',
        '../Renderer/CullFace',
        '../Renderer/DepthFunction',
        '../Renderer/PixelFormat',
        '../Renderer/MipmapHint',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        './Projections',
        './Tile',
        './TileState',
        './SceneMode',
        './Texture2DPool',
        './ViewportQuad',
        '../Shaders/CentralBodyVS',
        '../Shaders/CentralBodyFS',
        '../Shaders/CentralBodyFSCommon',
        '../Shaders/CentralBodyVSDepth',
        '../Shaders/CentralBodyFSDepth',
        '../Shaders/CentralBodyVSFilter',
        '../Shaders/CentralBodyFSFilter',
        '../Shaders/CentralBodyVSPole',
        '../Shaders/CentralBodyFSPole',
        '../Shaders/GroundAtmosphere',
        '../Shaders/SkyAtmosphereFS',
        '../Shaders/SkyAtmosphereVS'
    ], function(
        DeveloperError,
        RuntimeError,
        Color,
        combine,
        destroyObject,
        CesiumMath,
        Intersect,
        Occluder,
        Ellipsoid,
        Extent,
        BoundingSphere,
        BoundingRectangle,
        Cache,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Cartographic,
        Matrix3,
        Matrix4,
        Queue,
        ComponentDatatype,
        IndexDatatype,
        MeshFilters,
        PrimitiveType,
        CubeMapEllipsoidTessellator,
        ExtentTessellator,
        PlaneTessellator,
        JulianDate,
        Transforms,
        BufferUsage,
        Command,
        CommandLists,
        CullFace,
        DepthFunction,
        PixelFormat,
        MipmapHint,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        Projections,
        Tile,
        TileState,
        SceneMode,
        Texture2DPool,
        ViewportQuad,
        CentralBodyVS,
        CentralBodyFS,
        CentralBodyFSCommon,
        CentralBodyVSDepth,
        CentralBodyFSDepth,
        CentralBodyVSFilter,
        CentralBodyFSFilter,
        CentralBodyVSPole,
        CentralBodyFSPole,
        GroundAtmosphere,
        SkyAtmosphereFS,
        SkyAtmosphereVS) {
    "use strict";

    function TileTextureCachePolicy(description) {
        var desc = description || {};

        if (!desc.fetchFunc || typeof desc.fetchFunc !== 'function') {
            throw new DeveloperError('description.fetchFunc is a required function.');
        }

        this._limit = desc.limit || 128;
        this._count = 0;
        this._fetchFunc = desc.fetchFunc;
        this._removeFunc = (typeof desc.removeFunc === 'function') ? desc.removeFunc : undefined;
    }

    TileTextureCachePolicy.prototype.hit = function(object) {
        var time = new JulianDate();
        var current = object.key;
        while (current) {
            current._lastHit = time;
            current = current.parent;
        }
        return object.value;
    };

    TileTextureCachePolicy.prototype.miss = function(name, key, object) {
        var property = {
            key : key,
            value : undefined
        };

        property.value = this._fetchFunc(key);
        var lruTime = new JulianDate();
        this.hit(property);

        if (this._count < this._limit) {
            ++this._count;
            object[name] = property;
            return property.value;
        }

        var element;
        var index = '';
        var keys = Object.keys(object);
        for ( var i = 0; i < keys.length; ++i) {
            element = object[keys[i]];
            if (element.key._lastHit.lessThan(lruTime) && element.key.zoom > 2) {
                lruTime = element.key._lastHit;
                index = keys[i];
            }
        }

        element = object[index];
        if (this._removeFunc) {
            this._removeFunc(element.key);
        }
        delete object[index];

        object[name] = property;
        return property.value;
    };

    var attributeIndices = {
        position3D : 0,
        textureCoordinates : 1,
        position2D : 2
    };

    /**
     * DOC_TBA
     *
     * @alias CentralBody
     * @constructor
     *
     * @param {Ellipsoid} [ellipsoid=WGS84 Ellipsoid] Determines the size and shape of the central body.
     *
     */
    var CentralBody = function(ellipsoid) {
        ellipsoid = ellipsoid || Ellipsoid.WGS84;

        this._ellipsoid = ellipsoid;
        this._maxExtent = new Extent(
            -CesiumMath.PI,
            -CesiumMath.PI_OVER_TWO,
            CesiumMath.PI,
            CesiumMath.PI_OVER_TWO
        );
        this._rootTile = new Tile({
            extent : this._maxExtent,
            zoom : 0,
            ellipsoid : ellipsoid
        });
        this._occluder = new Occluder(new BoundingSphere(Cartesian3.ZERO, ellipsoid.getMinimumRadius()), Cartesian3.ZERO);

        this._renderQueue = new Queue();
        this._imageQueue = new Queue();
        this._textureQueue = new Queue();
        this._reprojectQueue = new Queue();

        this._texturePool = undefined;
        this._textureCache = undefined;
        this._textureCacheLimit = 512; // TODO: pick appropriate cache limit

        // TODO: pick appropriate throttle limits
        this._textureThrottleLimit = 10;
        this._reprojectThrottleLimit = 10;
        this._imageThrottleLimit = 15;

        this._prefetchLimit = 1;
        this._tileFailCount = 0;
        this._lastFailedTime = undefined;

        /**
         * The maximum number of tiles that can fail consecutively before the
         * central body will stop loading tiles.
         *
         * @type {Number}
         * @default 3
         */
        this.perTileMaxFailCount = 3;

        /**
         * The maximum number of failures allowed for each tile before the
         * central body will stop loading a failing tile.
         *
         * @type {Number}
         * @default 30
         */
        this.maxTileFailCount = 30;

        /**
         * The number of seconds between attempts to retry a failing tile.
         *
         * @type {Number}
         * @default 30.0
         */
        this.failedTileRetryTime = 30.0;

        this._spWithoutAtmosphere = undefined;
        this._spGroundFromSpace = undefined;
        this._spGroundFromAtmosphere = undefined;
        this._sp = undefined; // Reference to without-atmosphere, ground-from-space, or ground-from-atmosphere
        this._rsColor = undefined;
        this._tileCommandList = [];

        this._skyCommand = new Command();
        this._skyCommand.primitiveType = PrimitiveType.TRIANGLES;

        // this._skyCommand.shaderProgram references sky-from-space or sky-from-atmosphere
        this._spSkyFromSpace = undefined;
        this._spSkyFromAtmosphere = undefined;

        this._depthCommand = new Command();
        this._depthCommand.primitiveType = PrimitiveType.TRIANGLES;

        this._quadH = undefined;
        this._quadV = undefined;

        this._fb = undefined;

        this._northPoleCommand = new Command();
        this._northPoleCommand.primitiveType = PrimitiveType.TRIANGLE_FAN;
        this._southPoleCommand = new Command();
        this._southPoleCommand.primitiveType = PrimitiveType.TRIANGLE_FAN;

        // this._northPoleCommand.shaderProgram and this.southPoleCommand.shaderProgram reference
        // without-atmosphere, ground-from-space, or ground-from-atmosphere
        this._spPolesWithoutAtmosphere = undefined;
        this._spPolesGroundFromSpace = undefined;
        this._spPolesGroundFromAtmosphere = undefined;

        this._drawNorthPole = false;
        this._drawSouthPole = false;

        this._commandLists = new CommandLists();

        /**
         * Determines the color of the north pole. If the day tile provider imagery does not
         * extend over the north pole, it will be filled with this color before applying lighting.
         *
         * @type {Cartesian3}
         */
        this.northPoleColor = new Cartesian3(2.0 / 255.0, 6.0 / 255.0, 18.0 / 255.0);

        /**
         * Determines the color of the south pole. If the day tile provider imagery does not
         * extend over the south pole, it will be filled with this color before applying lighting.
         *
         * @type {Cartesian3}
         */
        this.southPoleColor = new Cartesian3(1.0, 1.0, 1.0);

        /**
         * Determines the position of the day tile provider logo. The day tile provider logo
         * is displayed in the bottom left corner of the viewport. This is used to offset the
         * position of the logo.
         *
         * @type {Cartesian2}
         */
        this.logoOffset = Cartesian2.ZERO;
        this._logoOffset = this.logoOffset;
        this._imageLogo = undefined;
        this._quadLogo = undefined;

        this._minTileDistance = undefined;

        /**
         * DOC_TBA
         *
         * @type {Number}
         * @default 5.0
         */
        this.pixelError3D = 5.0;

        /**
         * DOC_TBA
         *
         * @type {Number}
         * @default 2.0
         */
        this.pixelError2D = 2.0;

        /**
         * Determines if the central body will be shown.
         *
         * @type {Boolean}
         * @default true
         */
        this.show = true;

        /**
         * Determines if the ground atmosphere will be shown.
         *
         * @type {Boolean}
         * @default false
         */
        this.showGroundAtmosphere = false;

        /**
         * Determines if the sky atmosphere will be shown.
         *
         * @type {Boolean}
         * @default false
         */
        this.showSkyAtmosphere = false;

        /**
         * <p>
         * Determines if the central body is affected by lighting, i.e., if sun light brightens the
         * day side of the globe, and and the night side appears dark.  When <code>true</code>, the
         * central body is affected by lighting; when <code>false</code>, the central body is uniformly
         * shaded with the day tile provider, i.e., no night lights, atmosphere, etc. are used.
         * </p>
         * <p>
         * The default is <code>true</code>.
         * </p>
         *
         * @default true
         */
        this.affectedByLighting = true;
        this._affectedByLighting = true;

        /**
         * DOC_TBA
         */
        this.dayTileProvider = undefined;
        this._dayTileProvider = undefined;

        /**
         * The URL of the image to use as a night texture.  An asynchronous
         * request is made for the image at the next call to {@link CentralBody#update}.
         * The night texture is shown once the image is loaded and {@link CentralBody#showNight}
         * is <code>true</code>.
         * <br /><br />
         * Example day image:
         * <div align='center'>
         * <img src='../images/CentralBody.nightImageSource.jpg' width='512' height='256' />
         * <a href='http://visibleearth.nasa.gov/view_rec.php?id=1438'>NASA Visible Earth</a>.
         * Data courtesy Marc Imhoff of NASA GSFC and Christopher Elvidge of
         * NOAA NGDC. Image by Craig Mayhew and Robert Simmon, NASA GSFC.
         * </div>
         *
         * @type {String}
         *
         * @see CentralBody#showNight
         */
        this.nightImageSource = undefined;
        this._nightImageSource = undefined;
        this._nightTexture = undefined;

        /**
         * The URL of the image to use as a specular map; a single-channel image where zero indicates
         * land cover, and 255 indicates water.  An asynchronous request is made for the image
         * at the next call to {@link CentralBody#update}. The specular map is used once the
         * image is loaded and {@link CentralBody#showSpecular} is <code>true</code>.
         * <br /><br />
         * Example specular map:
         * <div align='center'>
         * <img src='../images/CentralBody.specularMapSource.jpg' width='512' height='256' />
         * <a href='http://planetpixelemporium.com/earth.html'>Planet Texture Maps</a>
         * </div>
         *
         * @type {String}
         *
         * @see CentralBody#showSpecular
         */
        this.specularMapSource = undefined;
        this._specularMapSource = undefined;
        this._specularTexture = undefined;

        /**
         * The URL of the image to use as a cloud map; a single-channel image where 255 indicates
         * cloud cover, and zero indicates no clouds.  An asynchronous request is made for the image
         * at the next call to {@link CentralBody#update}. The cloud map is shown once the
         * image is loaded and {@link CentralBody#showClouds} is <code>true</code>.
         * <br /><br />
         * Example cloud map:
         * <div align='center'>
         * <img src='../images/CentralBody.cloudsMapSource.jpg' width='512' height='256' />
         * <a href='http://planetpixelemporium.com/earth.html'>Planet Texture Maps</a>
         * </div>
         *
         * @type {String}
         *
         * @see CentralBody#showClouds
         */
        this.cloudsMapSource = undefined;
        this._cloudsMapSource = undefined;
        this._cloudsTexture = undefined;

        /**
         * The URL of the image to use as a bump map; a single-channel image where zero indicates
         * sea level, and 255 indicates maximum height.  An asynchronous request is made for the image
         * at the next call to {@link CentralBody#update}. The bump map is used once the
         * image is loaded and {@link CentralBody#showBumps} is <code>true</code>.
         * <br /><br />
         * Example bump map:
         * <div align='center'>
         * <img src='../images/CentralBody.bumpMapSource.jpg' width='512' height='256' />
         * <a href='http://planetpixelemporium.com/earth.html'>Planet Texture Maps</a>
         * </div>
         *
         * @type {String}
         *
         * @see CentralBody#showBumps
         */
        this.bumpMapSource = undefined;
        this._bumpMapSource = undefined;
        this._bumpTexture = undefined;

        /**
         * When <code>true</code>, textures from the <code>dayTileProvider</code> are shown on the central body.
         * <br /><br />
         * <div align='center'>
         * <img src='../images/CentralBody.showDay.jpg' width='400' height='300' />
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#dayTileProvider
         * @see CentralBody#showNight
         *
         * @default true
         */
        this.showDay = true;
        this._showDay = false;

        /**
         * When <code>true</code>, the night texture is shown on the side of the central body not illuminated by the sun.
         * The day and night textures are blended across the terminator using {@link CentralBody#dayNightBlendDelta}.
         * When <code>false</code>, the day textures are shown on the entire globe (if enabled).
         * <div align='center'>
         * <img src='../images/CentralBody.showNight.jpg' width='400' height='300' />
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#nightImageSource
         * @see CentralBody#showDay
         * @see CentralBody#dayNightBlendDelta
         *
         * @default true
         *
         * @example
         * cb.showNight = true;
         * cb.nightImageSource = 'night.jpg';
         */
        this.showNight = true;
        this._showNight = false;

        /**
         * When <code>true</code>, diffuse-lit clouds are shown on the central body.  When {@link CentralBody#showNight}
         * is also true, clouds on the dark side of the globe will fully or partially occlude the night texture.
         * <div align='center'>
         * <img src='../images/CentralBody.showClouds.jpg' width='400' height='300' />
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#cloudsMapSource
         * @see CentralBody#showCloudShadows
         * @see CentralBody#showNight
         *
         * @default true
         *
         * @example
         * cb.showClouds = true;
         * cb.cloudsMapSource = 'clouds.jpg';
         */
        this.showClouds = true;
        this._showClouds = false;

        /**
         * When <code>true</code>, clouds on the daytime side of the globe cast approximate shadows.  The
         * shadows can be shown with or without the clouds themselves, which are controlled with
         * {@link CentralBody#showClouds}.
         * <div align='center'>
         * <table border='0' cellpadding='5'><tr>
         * <td align='center'><code>true</code><br/><img src='../images/CentralBody.showCloudShadows.true.jpg' width='250' height='188' /></td>
         * <td align='center'><code>false</code><br/><img src='../images/CentralBody.showCloudShadows.false.jpg' width='250' height='188' /></td>
         * </tr></table>
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#cloudsMapSource
         * @see CentralBody#showClouds
         *
         * @default true
         *
         * @example
         * cb.showClouds = true;
         * cb.showCloudShadows = true;
         * cb.cloudsMapSource = 'clouds.jpg';
         */
        this.showCloudShadows = true;
        this._showCloudShadows = false;

        /**
         * When <code>true</code>, a specular map (also called a gloss map) is used so only the ocean receives specular light.
         * <div align='center'>
         * <table border='0' cellpadding='5'><tr>
         * <td align='center'><code>true</code><br/><img src='../images/CentralBody.showSpecular.true.jpg' width='250' height='188' /></td>
         * <td align='center'><code>false</code><br/><img src='../images/CentralBody.showSpecular.false.jpg' width='250' height='188' /></td>
         * </tr></table>
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#specularMapSource
         *
         * @default true
         *
         * @example
         * cb.showSpecular = true;
         * cb.specularMapSource = 'specular.jpg';
         */
        this.showSpecular = true;
        this._showSpecular = false;

        /**
         * When <code>true</code>, a bump map is used to add lighting detail to the mountainous areas of the central body.
         * This gives the appearance of extra geometric complexity even though the central body is still a smooth ellipsoid.
         * The apparent steepness of the mountains is controlled by {@link CentralBody#bumpMapNormalZ}.
         * <div align='center'>
         * <table border='0' cellpadding='5'><tr>
         * <td align='center'><code>true</code><br/><img src='../images/CentralBody.showBumps.true.jpg' width='250' height='188' /></td>
         * <td align='center'><code>false</code><br/><img src='../images/CentralBody.showBumps.false.jpg' width='250' height='188' /></td>
         * </tr></table>
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#bumpMapSource
         * @see CentralBody#bumpMapNormalZ
         *
         * @default true
         *
         * @example
         * cb.showBumps = true;
         * cb.bumpMapSource = 'bump.jpg';
         */
        this.showBumps = true;
        this._showBumps = false;

        /**
         * When <code>true</code>, shows a line on the central body where day meets night.
         * <div align='center'>
         * <img src='../images/CentralBody.showTerminator.jpg' width='400' height='300' />
         * </div>
         *
         * @type {Boolean}
         *
         * @see CentralBody#showNight
         * @see CentralBody#dayNightBlendDelta
         *
         * @default false
         */
        this.showTerminator = false;
        this._showTerminator = false;

        /**
         * When {@link CentralBody#showBumps} is <code>true</code>, <code>bumpMapNormalZ</code> controls the
         * apparent steepness of the mountains.  A value less than one over-exaggerates the steepness; a value greater
         * than one under-exaggerates, making mountains less noticeable.
         * <div align='center'>
         * <table border='0' cellpadding='5'><tr>
         * <td align='center'><code>0.25</code><br/><img src='../images/Centralbody.bumpMapNormalZ.025.jpg' width='250' height='188' /></td>
         * <td align='center'><code>1.25</code><br/><img src='../images/Centralbody.bumpMapNormalZ.125.jpg' width='250' height='188' /></td>
         * </tr></table>
         * </div>
         *
         * @type {Number}
         *
         * @see CentralBody#showBumps
         *
         * @default 0.5
         *
         * @example
         * cb.showBumps = true;
         * cb.bumpMapSource = 'bump.jpg';
         * cb.bumpMapNormalZ = 1.0;
         */
        this.bumpMapNormalZ = 0.5;

        /**
         * When {@link CentralBody#showDay} and {@link CentralBody#showNight} are both <code>true</code>,
         * <code>dayNightBlendDelta</code> determines the size of the blend region surrounding the terminator (where day
         * meets night).  A value of zero indicates a sharp transition without blending; a larger value creates a linearly
         * blended region based on the diffuse lighting component:  <code>-dayNightBlendDelta &lt; diffuse &lt; dayNightBlendDelta</code>.
         * <div align='center'>
         * <table border='0' cellpadding='5'><tr>
         * <td align='center'><code>0.0</code><br/><img src='../images/Centralbody.dayNightBlendDelta.0.jpg' width='250' height='188' /></td>
         * <td align='center'><code>0.05</code><br/><img src='../images/Centralbody.dayNightBlendDelta.05.jpg' width='250' height='188' /></td>
         * </tr></table>
         * </div>
         *
         * @type {Number}
         *
         * @see CentralBody#showDay
         * @see CentralBody#showNight
         * @see CentralBody#showTerminator
         *
         * @default 0.05
         *
         * @example
         * cb.showDay = true;
         * cb.dayTileProvider = new SingleTileProvider('day.jpg');
         * cb.showNight = true;
         * cb.nightImageSource = 'night.jpg';
         * cb.dayNightBlendDelta = 0.0;  // Sharp transition
         */
        this.dayNightBlendDelta = 0.05;

        /**
         * Changes the intensity of the night texture. A value of 1.0 is the same intensity as night texture.
         * A value less than 1.0 makes the night texture darker. A value greater than 1.0 makes the night texture
         * brighter. The default value is 2.0.
         *
         * @type {Number}
         *
         * @default 2.0
         */
        this.nightIntensity = 2.0;

        /**
         * The current morph transition time between 2D/Columbus View and 3D,
         * with 0.0 being 2D or Columbus View and 1.0 being 3D.
         *
         * @type Number
         *
         * @default 1.0
         */
        this.morphTime = 1.0;

        this._mode = SceneMode.SCENE3D;
        this._projection = undefined;

        this._fCameraHeight = undefined;
        this._fCameraHeight2 = undefined;
        this._outerRadius = ellipsoid.getRadii().multiplyByScalar(1.025).getMaximumComponent();

        // TODO: Do we want to expose any of these atmosphere constants?
        var Kr = 0.0025;
        var Kr4PI = Kr * 4.0 * Math.PI;
        var Km = 0.0015;
        var Km4PI = Km * 4.0 * Math.PI;
        var ESun = 15.0;
        var g = -0.95;
        var innerRadius = ellipsoid.getMaximumRadius();
        var rayleighScaleDepth = 0.25;
        var inverseWaveLength = {
            x : 1.0 / Math.pow(0.650, 4.0), // Red
            y : 1.0 / Math.pow(0.570, 4.0), // Green
            z : 1.0 / Math.pow(0.475, 4.0) // Blue
        };

        this._minGroundFromAtmosphereHeight = 6378500.0; // from experimentation / where shader fails due to precision errors
        this._startFadeGroundFromAtmosphere = this._minGroundFromAtmosphereHeight + 1000;

        var that = this;

        var atmosphereUniforms = {
            v3InvWavelength : function() {
                return inverseWaveLength;
            },
            fCameraHeight : function() {
                return that._fCameraHeight;
            },
            fCameraHeight2 : function() {
                return that._fCameraHeight2;
            },
            fOuterRadius : function() {
                return that._outerRadius;
            },
            fOuterRadius2 : function() {
                return that._outerRadius * that._outerRadius;
            },
            fInnerRadius : function() {
                return innerRadius;
            },
            fInnerRadius2 : function() {
                return innerRadius * innerRadius;
            },
            fKrESun : function() {
                return Kr * ESun;
            },
            fKmESun : function() {
                return Km * ESun;
            },
            fKr4PI : function() {
                return Kr4PI;
            },
            fKm4PI : function() {
                return Km4PI;
            },
            fScale : function() {
                return 1.0 / (that._outerRadius - innerRadius);
            },
            fScaleDepth : function() {
                return rayleighScaleDepth;
            },
            fScaleOverScaleDepth : function() {
                return (1.0 / (that._outerRadius - innerRadius)) / rayleighScaleDepth;
            },
            g : function() {
                return g;
            },
            g2 : function() {
                return g * g;
            },
            fMinGroundFromAtmosphereHeight : function() {
                return that._minGroundFromAtmosphereHeight;
            },
            fstartFadeGroundFromAtmosphere : function() {
                return that._startFadeGroundFromAtmosphere;
            }
        };

        var uniforms = {
            u_nightTexture : function() {
                return that._nightTexture;
            },
            u_cloudMap : function() {
                return that._cloudsTexture;
            },
            u_specularMap : function() {
                return that._specularTexture;
            },
            u_bumpMap : function() {
                return that._bumpTexture;
            },
            u_bumpMapResoltuion : function() {
                return {
                    x : 1.0 / that._bumpTexture.getWidth(),
                    y : 1.0 / that._bumpTexture.getHeight()
                };
            },
            u_bumpMapNormalZ : function() {
                return that.bumpMapNormalZ;
            },
            u_dayNightBlendDelta : function() {
                return that.dayNightBlendDelta;
            },
            u_nightIntensity : function() {
                return that.nightIntensity;
            },
            u_morphTime : function() {
                return that.morphTime;
            }
        };

        // PERFORMANCE_IDEA:  Only combine these if showing the atmosphere.  Maybe this is too much of a micro-optimization.
        // http://jsperf.com/object-property-access-propcount
        this._drawUniforms = combine([uniforms, atmosphereUniforms], false, false);
        this._skyCommand.uniformMap = this._drawUniforms;
    };

    /**
     * DOC_TBA
     *
     * @memberof CentralBody
     *
     * @return {Ellipsoid} DOC_TBA
     */
    CentralBody.prototype.getEllipsoid = function() {
        return this._ellipsoid;
    };

    CentralBody._isModeTransition = function(oldMode, newMode) {
        // SCENE2D, COLUMBUS_VIEW, and MORPHING use the same rendering path, so a
        // transition only occurs when switching from/to SCENE3D
        return ((oldMode !== newMode) &&
                ((oldMode === SceneMode.SCENE3D) ||
                 (newMode === SceneMode.SCENE3D)));
    };

    CentralBody.prototype._prefetchImages = function() {
        var limit = Math.max(Math.min(this._prefetchLimit, this._dayTileProvider.zoomMax), this._dayTileProvider.zoomMin);
        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            if (tile.zoom < limit) {
                this._processTile(tile);
                stack = stack.concat(tile.getChildren());
            } else if (tile.zoom === limit) {
                this._processTile(tile);
            }
        }
    };

    CentralBody.prototype._createTextureCache = function(context) {
        var pool = this._texturePool = new Texture2DPool(context);

        var fetch = function(tile) {
            var texture = pool.createTexture2D({
                width : tile.image.width,
                height : tile.image.height,
                pixelFormat : PixelFormat.RGB
            });
            return texture;
        };

        var remove = function(tile) {
            tile.texture = tile.texture && tile.texture.destroy();
            tile._extentVA = tile._extentVA && tile._extentVA.destroy();
            tile.projection = undefined;
            tile.state = TileState.READY;
        };

        var policy = new TileTextureCachePolicy({
            fetchFunc : fetch,
            removeFunc : remove,
            limit : this._textureCacheLimit
        });
        this._textureCache = new Cache(policy);
    };

    CentralBody.prototype._fetchImage = function(tile) {
        var that = this;
        var onload = function() {
            tile.state = TileState.IMAGE_LOADED;
        };
        var onerror = function() {
            tile._failCount = (tile._failCount) ? tile._failCount + 1 : 1;
            ++that._tileFailCount;
            that._lastFailedTime = new JulianDate();
            tile.state = TileState.IMAGE_FAILED;
        };
        var oninvalid = function() {
            tile.state = TileState.IMAGE_INVALID;
        };
        return this._dayTileProvider.loadTileImage(tile, onload, onerror, oninvalid);
    };

    CentralBody.prototype._getTileBoundingSphere = function(tile, frameState) {
        var boundingVolume;
        if (frameState.mode === SceneMode.SCENE3D) {
            return tile.get3DBoundingSphere();
        }

        boundingVolume = tile.get2DBoundingSphere(frameState.scene2D.projection).clone();
        boundingVolume.center = new Cartesian3(0.0, boundingVolume.center.x, boundingVolume.center.y);

        if (frameState.mode === SceneMode.MORPHING) {
            return tile.get3DBoundingSphere().union(boundingVolume);
        }

        return boundingVolume;
    };

    CentralBody.prototype._cull = function(tile, frameState) {
        var cullingVolume = frameState.cullingVolume;

        var boundingVolume = this._getTileBoundingSphere(tile, frameState);
        if (cullingVolume.getVisibility(boundingVolume) === Intersect.OUTSIDE) {
            return true;
        }

        if (frameState.mode === SceneMode.SCENE3D) {
            var occludeePoint = tile.getOccludeePoint();
            var occluder = this._occluder;
            return (occludeePoint && !occluder.isVisible(new BoundingSphere(occludeePoint, 0.0))) || !occluder.isVisible(boundingVolume);
        }

        return false;
    };

    CentralBody.prototype._throttleImages = function(frameState) {
        for ( var i = 0, len = this._imageQueue.length; i < len && i < this._imageThrottleLimit; ++i) {
            var tile = this._imageQueue.dequeue();

            if (this._cull(tile, frameState)) {
                tile.state = TileState.READY;
                continue;
            }

            if (this._dayTileProvider.zoomMin !== 0 && tile.zoom === 0 && tile.x === 0 && tile.y === 0) {
                tile.image = this._createBaseTile();
                tile.projection = Projections.WGS84; // no need to re-project
                tile.state = TileState.IMAGE_LOADED;
            } else {
                tile.image = this._fetchImage(tile);
                if (!tile.projection) {
                    tile.projection = this._dayTileProvider.projection;
                }
            }
        }
    };

    CentralBody.prototype._createBaseTile = function() {
        // Some tile servers, like Bing, don't have a base image for the entire central body.
        // Create a 1x1 image that will never get rendered.
        var canvas = document.createElement('canvas');
        canvas.width = 1.0;
        canvas.height = 1.0;

        return canvas;
    };

    CentralBody.prototype._throttleReprojection = function(frameState) {
        for ( var i = 0, len = this._reprojectQueue.length; i < len && i < this._reprojectThrottleLimit; ++i) {
            var tile = this._reprojectQueue.dequeue();

            if (this._cull(tile, frameState)) {
                tile.image = undefined;
                tile.state = TileState.READY;
                continue;
            }

            tile.image = tile.projection.toWgs84(tile.extent, tile.image);
            tile.state = TileState.REPROJECTED;
            tile.projection = Projections.WGS84;
        }
    };

    CentralBody.prototype._throttleTextures = function(context, frameState) {
        for ( var i = 0, len = this._textureQueue.length; i < len && i < this._textureThrottleLimit; ++i) {
            var tile = this._textureQueue.dequeue();

            if (this._cull(tile, frameState) || !tile.image) {
                tile.image = undefined;
                tile.state = TileState.READY;
                continue;
            }

            tile.texture = this._textureCache.find(tile);
            tile.texture.copyFrom(tile.image);
            tile.texture.generateMipmap(MipmapHint.NICEST);
            tile.texture.setSampler({
                wrapS : TextureWrap.CLAMP,
                wrapT : TextureWrap.CLAMP,
                minificationFilter : TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
                magnificationFilter : TextureMagnificationFilter.LINEAR,
                maximumAnisotropy : context.getMaximumTextureFilterAnisotropy() || 8 // TODO: Remove Chrome work around
            });
            tile.state = TileState.TEXTURE_LOADED;
            tile.image = undefined;
        }
    };

    CentralBody.prototype._processTile = function(tile) {
        if (this._imageQueue.contains(tile) || this._reprojectQueue.contains(tile) || this._textureQueue.contains(tile)) {
            return;
        }

        var maxFailed = this._tileFailCount > this._maxTileFailCount;
        var requestFailed = tile.state === TileState.IMAGE_FAILED && tile._failCount < this._maxTileFailCount;
        var maxTimePassed = this._lastFailedTime && this._lastFailedTime.getSecondsDifference(new JulianDate()) >= this.failedTileRetryTime;
        var retry = maxTimePassed || (requestFailed && !maxFailed);

        // check if tile needs to load image
        if (!tile.state || tile.state === TileState.READY) {
            this._imageQueue.enqueue(tile);
            tile.state = TileState.IMAGE_LOADING;
        } else if (tile.state === TileState.IMAGE_LOADED) {
            // or re-project the image
            this._reprojectQueue.enqueue(tile);
            tile.state = TileState.REPROJECTING;
        } else if (tile.state === TileState.REPROJECTED) {
            // or copy to a texture
            this._textureQueue.enqueue(tile);
            tile.state = TileState.TEXTURE_LOADING;
        } else if (retry) {
            // or retry a failed image
            if (maxTimePassed) {
                tile._failCount = 0;
                this._tileFailCount = 0;
            }
            this._imageQueue.enqueue(tile);
            tile.state = TileState.IMAGE_LOADING;
        } else if (tile.state === TileState.IMAGE_INVALID && tile.image) {
            // or release invalid image if there is one
            tile.image = undefined;
        }
    };

    CentralBody.prototype._enqueueTile = function(tile, context, frameState) {
        if (this._renderQueue.contains(tile)) {
            return;
        }

        var mode = frameState.mode;
        var projection = frameState.scene2D.projection;

        // create vertex array the first time it is needed or when morphing
        if (!tile._extentVA ||
            tile._extentVA.isDestroyed() ||
            CentralBody._isModeTransition(this._mode, mode) ||
            tile._mode !== mode ||
            this._projection !== projection) {
            tile._extentVA = tile._extentVA && tile._extentVA.destroy();

            var ellipsoid = this._ellipsoid;
            var rtc = tile.get3DBoundingSphere().center;
            var projectedRTC = tile.get2DBoundingSphere(projection).center.clone();

            var gran = (tile.zoom > 0) ? 0.05 * (1.0 / tile.zoom * 2.0) : 0.05; // seems like a good value after testing it for what looks good

            var typedArray;
            var buffer;
            var stride;
            var attributes;
            var indexBuffer;
            var datatype = ComponentDatatype.FLOAT;
            var usage = BufferUsage.STATIC_DRAW;

            if (mode === SceneMode.SCENE3D) {
                var buffers = ExtentTessellator.computeBuffers({
                    ellipsoid : ellipsoid,
                    extent : tile.extent,
                    granularity : gran,
                    generateTextureCoords : true,
                    interleave : true,
                    relativeToCenter : rtc
                });

                typedArray = datatype.toTypedArray(buffers.vertices);
                buffer = context.createVertexBuffer(typedArray, usage);
                stride = 5 * datatype.sizeInBytes;
                attributes = [{
                    index : attributeIndices.position3D,
                    vertexBuffer : buffer,
                    componentDatatype : datatype,
                    componentsPerAttribute : 3,
                    offsetInBytes : 0,
                    strideInBytes : stride
                }, {
                    index : attributeIndices.textureCoordinates,
                    vertexBuffer : buffer,
                    componentDatatype : datatype,
                    componentsPerAttribute : 2,
                    offsetInBytes : 3 * datatype.sizeInBytes,
                    strideInBytes : stride
                }, {
                    index : attributeIndices.position2D,
                    value : [0.0, 0.0]
                }];
                indexBuffer = context.createIndexBuffer(new Uint16Array(buffers.indices), usage, IndexDatatype.UNSIGNED_SHORT);
            } else {
                var vertices = [];
                var width = tile.extent.east - tile.extent.west;
                var height = tile.extent.north - tile.extent.south;
                var lonScalar = 1.0 / width;
                var latScalar = 1.0 / height;

                var mesh = PlaneTessellator.compute({
                    resolution : {
                        x : Math.max(Math.ceil(width / gran), 2.0),
                        y : Math.max(Math.ceil(height / gran), 2.0)
                    },
                    onInterpolation : function(time) {
                        var lonLat = new Cartographic(
                                CesiumMath.lerp(tile.extent.west, tile.extent.east, time.x),
                                CesiumMath.lerp(tile.extent.south, tile.extent.north, time.y));

                        var p = ellipsoid.cartographicToCartesian(lonLat).subtract(rtc);
                        vertices.push(p.x, p.y, p.z);

                        var u = (lonLat.longitude - tile.extent.west) * lonScalar;
                        var v = (lonLat.latitude - tile.extent.south) * latScalar;
                        vertices.push(u, v);

                        // TODO: This will not work if the projection's ellipsoid is different
                        // than the central body's ellipsoid.  Throw an exception?
                        var projectedLonLat = projection.project(lonLat).subtract(projectedRTC);
                        vertices.push(projectedLonLat.x, projectedLonLat.y);
                    }
                });

                typedArray = datatype.toTypedArray(vertices);
                buffer = context.createVertexBuffer(typedArray, usage);
                stride = 7 * datatype.sizeInBytes;
                attributes = [{
                    index : attributeIndices.position3D,
                    vertexBuffer : buffer,
                    componentDatatype : datatype,
                    componentsPerAttribute : 3,
                    offsetInBytes : 0,
                    strideInBytes : stride
                }, {
                    index : attributeIndices.textureCoordinates,
                    vertexBuffer : buffer,
                    componentDatatype : datatype,
                    componentsPerAttribute : 2,
                    offsetInBytes : 3 * datatype.sizeInBytes,
                    strideInBytes : stride
                }, {
                    index : attributeIndices.position2D,
                    vertexBuffer : buffer,
                    componentDatatype : datatype,
                    componentsPerAttribute : 2,
                    offsetInBytes : 5 * datatype.sizeInBytes,
                    strideInBytes : stride
                }];

                indexBuffer = context.createIndexBuffer(new Uint16Array(mesh.indexLists[0].values), usage, IndexDatatype.UNSIGNED_SHORT);
            }

            tile._extentVA = context.createVertexArray(attributes, indexBuffer);

            var intensity = (this._dayTileProvider && this._dayTileProvider.getIntensity && this._dayTileProvider.getIntensity(tile)) || 0.0;
            var drawUniforms = {
                u_dayTexture : function() {
                    return tile.texture;
                },
                u_center3D : function() {
                    return rtc;
                },
                u_center2D : function() {
                    return typeof projectedRTC !== 'undefined' ? projectedRTC : Cartesian2.ZERO;
                },
                u_modifiedModelView : function() {
                    return tile.modelView;
                },
                u_dayIntensity : function() {
                    return intensity;
                },
                u_mode : function() {
                    return tile.mode;
                }
            };
            tile._drawUniforms = combine([drawUniforms, this._drawUniforms], false, false);

            tile._mode = mode;
        }
        this._renderQueue.enqueue(tile);
    };

    CentralBody.prototype._createTileDistanceFunction = function(frameState, width, height) {
        var provider = this._dayTileProvider;
        if (typeof provider === 'undefined') {
            return undefined;
        }

        if (frameState.mode === SceneMode.SCENE2D) {
            return undefined;
        }

        var frustum = frameState.camera.frustum;
        var extent = provider.maxExtent;

        var pixelSizePerDistance = 2.0 * Math.tan(frustum.fovy * 0.5);
        if (height > width * frustum.aspectRatio) {
            pixelSizePerDistance /= height;
        } else {
            pixelSizePerDistance /= width;
        }

        var invPixelSizePerDistance = 1.0 / pixelSizePerDistance;
        var texelHeight = (extent.north - extent.south) / provider.tileHeight;
        var texelWidth = (extent.east - extent.west) / provider.tileWidth;
        var texelSize = (texelWidth > texelHeight) ? texelWidth : texelHeight;
        var dmin = texelSize * invPixelSizePerDistance;
        dmin *= this._ellipsoid.getMaximumRadius();

        return function(zoom, pixelError) {
            return (dmin / pixelError) * Math.exp(-0.693147181 * zoom);
        };
    };

    CentralBody.prototype._refine3D = function(tile, context, frameState) {
        var provider = this._dayTileProvider;
        if (typeof provider === 'undefined') {
            return false;
        }

        if (tile.zoom < provider.zoomMin) {
            return true;
        }

        if (typeof this._minTileDistance === 'undefined') {
            return false;
        }

        var boundingVolume = this._getTileBoundingSphere(tile, frameState);
        var cameraPosition = frameState.camera.getPositionWC();
        var direction = frameState.camera.getDirectionWC();

        var texturePixelError = (this.pixelError3D !== 'undefined' && this.pixelError3D > 0.0) ? this.pixelError3D : 1.0;
        var dmin = this._minTileDistance(tile.zoom, texturePixelError);

        var toCenter = boundingVolume.center.subtract(cameraPosition);
        var toSphere = toCenter.normalize().multiplyByScalar(toCenter.magnitude() - boundingVolume.radius);
        var distance = direction.multiplyByScalar(direction.dot(toSphere)).magnitude();

        if (distance > 0.0 && distance < dmin) {
            return true;
        }

        return false;
    };

    CentralBody.prototype._refine2D = function(tile, context, frameState) {
        var camera = frameState.camera;
        var frustum = camera.frustum;
        var pixelError = this.pixelError2D;
        var provider = this._dayTileProvider;

        var projection = frameState.scene2D.projection;
        var canvas = context.getCanvas();
        var width = canvas.clientWidth;
        var height = canvas.clientHeight;

        if (typeof provider === 'undefined') {
            return false;
        }

        if (tile.zoom < provider.zoomMin) {
            return true;
        }

        var texturePixelError = (pixelError > 0.0) ? pixelError : 1.0;

        var tileWidth, tileHeight;
        if (tile.texture && !tile.texture.isDestroyed()) {
            tileWidth = tile.texture.getWidth();
            tileHeight = tile.texture.getHeight();
        } else if (tile.image && typeof tile.image.width !== 'undefined') {
            tileWidth = tile.image.width;
            tileHeight = tile.image.height;
        } else {
            tileWidth = provider.tileWidth;
            tileHeight = provider.tileHeight;
        }

        var a = projection.project(new Cartographic(tile.extent.west, tile.extent.north));
        var b = projection.project(new Cartographic(tile.extent.east, tile.extent.south));
        var diagonal = a.subtract(b);
        var texelSize = Math.max(diagonal.x, diagonal.y) / Math.max(tileWidth, tileHeight);
        var pixelSize = Math.max(frustum.top - frustum.bottom, frustum.right - frustum.left) / Math.max(width, height);

        if (texelSize > pixelSize * texturePixelError) {
            return true;
        }

        return false;
    };

    CentralBody.prototype._refine = function(tile, context, frameState) {
        if (frameState.mode === SceneMode.SCENE2D) {
            return this._refine2D(tile, context, frameState);
        }

        return this._refine3D(tile, context, frameState);
    };

    CentralBody.prototype._createScissorRectangle = function(description) {
        var quad = description.quad;

        var upperLeft = new Cartesian3(quad[0], quad[1], quad[2]);
        var lowerLeft = new Cartesian3(quad[3], quad[4], quad[5]);
        var upperRight = new Cartesian3(quad[6], quad[7], quad[8]);
        var lowerRight = new Cartesian3(quad[9], quad[10], quad[11]);

        var mvp = description.modelViewProjection;
        var vt = description.viewportTransformation;

        var diag1 = upperRight.subtract(lowerLeft);
        var diag2 = upperLeft.subtract(lowerRight);

        var diag1Length = diag1.magnitude();
        var diag2Length = diag2.magnitude();

        var halfWidth = Math.max(diag1Length, diag2Length) * 0.5;
        var halfHeight = halfWidth;

        var center = lowerLeft.add(diag1.normalize().multiplyByScalar(diag1Length * 0.5));

        var camera = description.frameState.camera;
        var nearCenter = camera.position.add(camera.direction.multiplyByScalar(camera.frustum.near));

        if (camera.direction.dot(center.subtract(nearCenter)) < 0) {
            center = center.subtract(nearCenter);
            var centerProjN = camera.direction.multiplyByScalar(camera.direction.dot(center));
            var centerRejN = center.subtract(centerProjN);
            center = nearCenter.add(centerRejN);
        }

        lowerLeft = center.add(camera.up.multiplyByScalar(-halfHeight)).add(camera.right.multiplyByScalar(-halfWidth));
        Transforms.pointToWindowCoordinates(mvp, vt, lowerLeft, lowerLeft);
        upperRight = center.add(camera.up.multiplyByScalar(halfHeight)).add(camera.right.multiplyByScalar(halfWidth));
        Transforms.pointToWindowCoordinates(mvp, vt, upperRight, upperRight);

        lowerLeft.x = Math.max(0.0, Math.min(lowerLeft.x, description.width));
        lowerLeft.y = Math.max(0.0, Math.min(lowerLeft.y, description.height));
        upperRight.x = Math.max(0.0, Math.min(upperRight.x, description.width));
        upperRight.y = Math.max(0.0, Math.min(upperRight.y, description.height));

        var x = Math.floor(lowerLeft.x);
        var y = Math.floor(lowerLeft.y);
        var width = Math.ceil(upperRight.x) - x;
        var height = Math.ceil(upperRight.y) - y;

        if (width > 0.0 && height > 0.0) {
            return new BoundingRectangle(x, y, width, height);
        }

        return undefined;
    };

    CentralBody.prototype._computeDepthQuad = function(frameState) {
        var radii = this._ellipsoid.getRadii();
        var p = frameState.camera.getPositionWC();

        // Find the corresponding position in the scaled space of the ellipsoid.
        var q = this._ellipsoid.getOneOverRadii().multiplyComponents(p);

        var qMagnitude = q.magnitude();
        var qUnit = q.normalize();

        // Determine the east and north directions at q.
        var eUnit = Cartesian3.UNIT_Z.cross(q).normalize();
        var nUnit = qUnit.cross(eUnit).normalize();

        // Determine the radius of the 'limb' of the ellipsoid.
        var wMagnitude = Math.sqrt(q.magnitudeSquared() - 1.0);

        // Compute the center and offsets.
        var center = qUnit.multiplyByScalar(1.0 / qMagnitude);
        var scalar = wMagnitude / qMagnitude;
        var eastOffset = eUnit.multiplyByScalar(scalar);
        var northOffset = nUnit.multiplyByScalar(scalar);

        // A conservative measure for the longitudes would be to use the min/max longitudes of the bounding frustum.
        var upperLeft = radii.multiplyComponents(center.add(northOffset).subtract(eastOffset));
        var upperRight = radii.multiplyComponents(center.add(northOffset).add(eastOffset));
        var lowerLeft = radii.multiplyComponents(center.subtract(northOffset).subtract(eastOffset));
        var lowerRight = radii.multiplyComponents(center.subtract(northOffset).add(eastOffset));
        return [upperLeft.x, upperLeft.y, upperLeft.z, lowerLeft.x, lowerLeft.y, lowerLeft.z, upperRight.x, upperRight.y, upperRight.z, lowerRight.x, lowerRight.y, lowerRight.z];
    };

    CentralBody.prototype._computePoleQuad = function(frameState, maxLat, maxGivenLat, viewProjMatrix, viewportTransformation) {
        var pt1 = this._ellipsoid.cartographicToCartesian(new Cartographic(0.0, maxGivenLat));
        var pt2 = this._ellipsoid.cartographicToCartesian(new Cartographic(Math.PI, maxGivenLat));
        var radius = pt1.subtract(pt2).magnitude() * 0.5;

        var center = this._ellipsoid.cartographicToCartesian(new Cartographic(0.0, maxLat));

        var right;
        var dir = frameState.camera.direction;
        if (1.0 - Cartesian3.UNIT_Z.negate().dot(dir) < CesiumMath.EPSILON6) {
            right = Cartesian3.UNIT_X;
        } else {
            right = dir.cross(Cartesian3.UNIT_Z).normalize();
        }

        var screenRight = center.add(right.multiplyByScalar(radius));
        var screenUp = center.add(Cartesian3.UNIT_Z.cross(right).normalize().multiplyByScalar(radius));

        Transforms.pointToWindowCoordinates(viewProjMatrix, viewportTransformation, center, center);
        Transforms.pointToWindowCoordinates(viewProjMatrix, viewportTransformation, screenRight, screenRight);
        Transforms.pointToWindowCoordinates(viewProjMatrix, viewportTransformation, screenUp, screenUp);

        var halfWidth = Math.floor(Math.max(screenUp.subtract(center).magnitude(), screenRight.subtract(center).magnitude()));
        var halfHeight = halfWidth;

        return new BoundingRectangle(
                Math.floor(center.x) - halfWidth,
                Math.floor(center.y) - halfHeight,
                halfWidth * 2.0,
                halfHeight * 2.0);
    };

    var viewportScratch = new BoundingRectangle();
    var vpTransformScratch = new Matrix4();
    CentralBody.prototype._fillPoles = function(context, frameState) {
        if (typeof this._dayTileProvider === 'undefined' || frameState.mode !== SceneMode.SCENE3D) {
            return;
        }

        var viewProjMatrix = context.getUniformState().getViewProjection();
        var viewport = viewportScratch;
        viewport.width = context.getCanvas().clientWidth;
        viewport.height = context.getCanvas().clientHeight;
        var viewportTransformation = Matrix4.computeViewportTransformation(viewport, 0.0, 1.0, vpTransformScratch);
        var latitudeExtension = 0.05;

        var extent;
        var boundingVolume;
        var frustumCull;
        var occludeePoint;
        var occluded;
        var datatype;
        var mesh;
        var rect;
        var positions;
        var occluder = this._occluder;

        // handle north pole
        if (this._dayTileProvider.maxExtent.north < CesiumMath.PI_OVER_TWO) {
            extent = new Extent(
                -Math.PI,
                this._dayTileProvider.maxExtent.north,
                Math.PI,
                CesiumMath.PI_OVER_TWO
            );
            boundingVolume = BoundingSphere.fromExtent3D(extent, this._ellipsoid);
            frustumCull = frameState.cullingVolume.getVisibility(boundingVolume) === Intersect.OUTSIDE;
            occludeePoint = Occluder.computeOccludeePointFromExtent(extent, this._ellipsoid);
            occluded = (occludeePoint && !occluder.isVisible(new BoundingSphere(occludeePoint, 0.0))) || !occluder.isVisible(boundingVolume);

            this._drawNorthPole = !frustumCull && !occluded;
            if (this._drawNorthPole) {
                rect = this._computePoleQuad(frameState, extent.north, extent.south - latitudeExtension, viewProjMatrix, viewportTransformation);
                positions = [
                    rect.x, rect.y,
                    rect.x + rect.width, rect.y,
                    rect.x + rect.width, rect.y + rect.height,
                    rect.x, rect.y + rect.height
                ];

                if (typeof this._northPoleCommand.vertexArray === 'undefined') {
                    mesh = {
                        attributes : {
                            position : {
                                componentDatatype : ComponentDatatype.FLOAT,
                                componentsPerAttribute : 2,
                                values : positions
                            }
                        }
                    };
                    this._northPoleCommand.vertexArray = context.createVertexArrayFromMesh({
                        mesh : mesh,
                        attributeIndices : {
                            position : 0
                        },
                        bufferUsage : BufferUsage.STREAM_DRAW
                    });
                } else {
                    datatype = ComponentDatatype.FLOAT;
                    this._northPoleCommand.vertexArray.getAttribute(0).vertexBuffer.copyFromArrayView(datatype.toTypedArray(positions));
                }
            }
        }

        // handle south pole
        if (this._dayTileProvider.maxExtent.south > -CesiumMath.PI_OVER_TWO) {
            extent = new Extent(
                -Math.PI,
                -CesiumMath.PI_OVER_TWO,
                Math.PI,
                this._dayTileProvider.maxExtent.south
            );
            boundingVolume = BoundingSphere.fromExtent3D(extent, this._ellipsoid);
            frustumCull = frameState.cullingVolume.getVisibility(boundingVolume) === Intersect.OUTSIDE;
            occludeePoint = Occluder.computeOccludeePointFromExtent(extent, this._ellipsoid);
            occluded = (occludeePoint && !occluder.isVisible(new BoundingSphere(occludeePoint, 0.0))) || !occluder.isVisible(boundingVolume);

            this._drawSouthPole = !frustumCull && !occluded;
            if (this._drawSouthPole) {
                rect = this._computePoleQuad(frameState, extent.south, extent.north + latitudeExtension, viewProjMatrix, viewportTransformation);
                positions = [
                     rect.x, rect.y,
                     rect.x + rect.width, rect.y,
                     rect.x + rect.width, rect.y + rect.height,
                     rect.x, rect.y + rect.height
                 ];

                 if (typeof this._southPoleCommand.vertexArray === 'undefined') {
                     mesh = {
                         attributes : {
                             position : {
                                 componentDatatype : ComponentDatatype.FLOAT,
                                 componentsPerAttribute : 2,
                                 values : positions
                             }
                         }
                     };
                     this._southPoleCommand.vertexArray = context.createVertexArrayFromMesh({
                         mesh : mesh,
                         attributeIndices : {
                             position : 0
                         },
                         bufferUsage : BufferUsage.STREAM_DRAW
                     });
                 } else {
                     datatype = ComponentDatatype.FLOAT;
                     this._southPoleCommand.vertexArray.getAttribute(0).vertexBuffer.copyFromArrayView(datatype.toTypedArray(positions));
                 }
            }
        }

        var that = this;
        var drawUniforms = {
            u_fbTexture : function() {
                return that._fb.getColorTexture();
            },
            u_dayIntensity : function() {
                return (that._dayTileProvider && that._dayTileProvider.getPoleIntensity && that._dayTileProvider.getPoleIntensity()) || 0.0;
            }
        };

        if (typeof this._northPoleCommand.uniformMap === 'undefined') {
            var northPoleUniforms = combine([drawUniforms, {
                u_color : function() {
                    return that.northPoleColor;
                }
            }], false, false);
            this._northPoleCommand.uniformMap = combine([northPoleUniforms, this._drawUniforms], false, false);
        }

        if (typeof this._southPoleCommand.uniformMap === 'undefined') {
            var southPoleUniforms = combine([drawUniforms, {
                u_color : function() {
                    return that.southPoleColor;
                }
            }], false, false);
            this._southPoleCommand.uniformMap = combine([southPoleUniforms, this._drawUniforms], false, false);
        }
    };

    var clearState = {
        framebuffer : undefined,
        color : new Color(0.0, 0.0, 0.0, 0.0)
    };

    var scratchQuadCommands = [];
    /**
     * @private
     */
    CentralBody.prototype.update = function(context, frameState, commandList) {
        if (!this.show) {
            return;
        }

        var width = context.getCanvas().clientWidth;
        var height = context.getCanvas().clientHeight;

        if (width === 0 || height === 0) {
            return;
        }

        var mode = frameState.mode;
        var projection = frameState.scene2D.projection;

        if (this._dayTileProvider !== this.dayTileProvider) {
            this._dayTileProvider = this.dayTileProvider;

            // destroy logo
            this._quadLogo = this._quadLogo && this._quadLogo.destroy();

            // stop loading everything
            this._imageQueue.clear();
            this._textureQueue.clear();
            this._reprojectQueue.clear();

            // destroy tiles
            this._destroyTileTree();

            // destroy resources
            this._texturePool = this._texturePool && this._texturePool.destroy();
            this._textureCache = this._textureCache && this._textureCache.destroy();

            // create new tile tree
            this._rootTile = new Tile({
                extent : this._dayTileProvider.maxExtent || this._maxExtent,
                zoom : 0,
                ellipsoid : this._ellipsoid
            });

            this._prefetchImages();
        }

        var hasLogo = this._dayTileProvider && this._dayTileProvider.getLogo;
        var imageLogo =  (hasLogo) ? this._dayTileProvider.getLogo() : undefined;
        var createLogo = !this._quadLogo || this._quadLogo.isDestroyed();
        var updateLogo = createLogo || this._imageLogo !== imageLogo;
        if (updateLogo) {
            if (typeof imageLogo === 'undefined') {
                this._quadLogo = this._quadLogo && this._quadLogo.destroy();
            }
            else {
                this._quadLogo = new ViewportQuad(new BoundingRectangle(this.logoOffset.x, this.logoOffset.y, imageLogo.width, imageLogo.height));
                this._quadLogo.setTexture(context.createTexture2D({
                    source : imageLogo,
                    pixelFormat : PixelFormat.RGBA
                }));
                this._quadLogo.enableBlending = true;
            }
            this._imageLogo = imageLogo;
        } else if (this._quadLogo && this._imageLogo && !this.logoOffset.equals(this._logoOffset)) {
            this._quadLogo.setRectangle(new BoundingRectangle(this.logoOffset.x, this.logoOffset.y, this._imageLogo.width, this._imageLogo.height));
            this._logoOffset = this.logoOffset;
        }

        if (!this._textureCache || this._textureCache.isDestroyed()) {
            this._createTextureCache(context);
        }

        var createFBO = !this._fb || this._fb.isDestroyed();
        var fboDimensionsChanged = this._fb && (this._fb.getColorTexture().getWidth() !== width || this._fb.getColorTexture().getHeight() !== height);

        if (createFBO || fboDimensionsChanged ||
            (!this._quadV || this._quadV.isDestroyed()) ||
            (!this._quadH || this._quadH.isDestroyed())) {

            this._minTileDistance = this._createTileDistanceFunction(frameState, width, height);

            this._fb = this._fb && this._fb.destroy();
            this._quadV = this._quadV && this._quadV.destroy();
            this._quadH = this._quadH && this._quadH.destroy();

            // create FBO and texture render targets
            this._fb = context.createFramebuffer({
                colorTexture : context.createTexture2D({
                    width : width,
                    height : height,
                    pixelFormat : PixelFormat.RGBA
                })
            });

            this._skyCommand.framebuffer = this._fb;

            // create viewport quad for vertical gaussian blur pass
            this._quadV = new ViewportQuad(
                new BoundingRectangle(0.0, 0.0, width, height),
                '#define VERTICAL 1\n' + CentralBodyVSFilter,
                CentralBodyFSFilter);
            this._quadV.uniforms.u_height = function() {
                return height;
            };
            this._quadV.setTexture(this._fb.getColorTexture());
            this._quadV.setDestroyTexture(false);
            this._quadV.setFramebuffer(context.createFramebuffer({
                colorTexture : context.createTexture2D({
                    width : width,
                    height : height,
                    pixelFormat : PixelFormat.RGBA
                })
            }));
            this._quadV.setDestroyFramebuffer(true);

            // create viewport quad for horizontal gaussian blur pass
            this._quadH = new ViewportQuad(
                new BoundingRectangle(0.0, 0.0, width, height),
                CentralBodyVSFilter,
                CentralBodyFSFilter);
            this._quadH.uniforms.u_width = function() {
                return width;
            };
            this._quadH.setTexture(this._quadV.getFramebuffer().getColorTexture());
            this._quadH.setDestroyTexture(false);
        }

        if ((mode !== SceneMode.SCENE2D && mode !== SceneMode.MORPHING) && typeof this._minTileDistance === 'undefined') {
            this._minTileDistance = this._createTileDistanceFunction(frameState, width, height);
        }

        var vs, fs;

        if (this.showSkyAtmosphere && !this._skyCommand.vertexArray) {
            // PERFORMANCE_IDEA:  Is 60 the right amount to tessellate?  I think scaling the original
            // geometry in a vertex is a bad idea; at least, because it introduces a draw call per tile.
            var skyMesh = CubeMapEllipsoidTessellator.compute(Ellipsoid.fromCartesian3(this._ellipsoid.getRadii().multiplyByScalar(1.025)), 60);
            this._skyCommand.vertexArray = context.createVertexArrayFromMesh({
                mesh : skyMesh,
                attributeIndices : MeshFilters.createAttributeIndices(skyMesh),
                bufferUsage : BufferUsage.STATIC_DRAW
            });

            vs = '#define SKY_FROM_SPACE \n' +
                 '#line 0 \n' +
                 SkyAtmosphereVS;

            fs = '#line 0\n' +
                 SkyAtmosphereFS;

            this._spSkyFromSpace = context.getShaderCache().getShaderProgram(vs, fs);

            vs = '#define SKY_FROM_ATMOSPHERE' +
                 '#line 0 \n' +
                 SkyAtmosphereVS;

            this._spSkyFromAtmosphere = context.getShaderCache().getShaderProgram(vs, fs);
            this._skyCommand.renderState = context.createRenderState({
                cull : {
                    enabled : true,
                    face : CullFace.FRONT
                }
                // TODO: revisit when multi-frustum/depth test is ready
                /*depthTest : {
                    enabled : true
                },
                depthMask : false*/
            });
        }

        if (CentralBody._isModeTransition(this._mode, mode) || this._projection !== projection) {
            if (mode === SceneMode.SCENE3D) {
                this._rsColor = context.createRenderState({ // Write color, not depth
                    cull : {
                        enabled : true
                    }
                });
                this._depthCommand.renderState = context.createRenderState({ // Write depth, not color
                    cull : {
                        enabled : true
                    },
                    depthTest : {
                        enabled : true,
                        func : DepthFunction.ALWAYS
                    },
                    colorMask : {
                        red : false,
                        green : false,
                        blue : false,
                        alpha : false
                    }
                });
            } else {
                this._rsColor = context.createRenderState();
                this._depthCommand.renderState = context.createRenderState();
            }
        }

        // TODO: Wait until multi-frustum
        //this._rsColor.depthTest.enabled = (mode === SceneMode.MORPHING);  // Depth test during morph
        var cull = (mode === SceneMode.SCENE3D) || (mode === SceneMode.MORPHING);
        this._rsColor.cull.enabled = cull;
        this._depthCommand.renderState.cull.enabled = cull;

        this._northPoleCommand.renderState = this._rsColor;
        this._southPoleCommand.renderState = this._rsColor;

        // update depth plane
        var depthQuad = this._computeDepthQuad(frameState);

        // depth plane
        if (!this._depthCommand.vertexArray) {
            var mesh = {
                attributes : {
                    position : {
                        componentDatatype : ComponentDatatype.FLOAT,
                        componentsPerAttribute : 3,
                        values : depthQuad
                    }
                },
                indexLists : [{
                    primitiveType : PrimitiveType.TRIANGLES,
                    values : [0, 1, 2, 2, 1, 3]
                }]
            };
            this._depthCommand.vertexArray = context.createVertexArrayFromMesh({
                mesh : mesh,
                attributeIndices : {
                    position : 0
                },
                bufferUsage : BufferUsage.DYNAMIC_DRAW
            });
        } else {
            var datatype = ComponentDatatype.FLOAT;
            this._depthCommand.vertexArray.getAttribute(0).vertexBuffer.copyFromArrayView(datatype.toTypedArray(depthQuad));
        }

        if (!this._depthCommand.shaderProgram) {
            this._depthCommand.shaderProgram = context.getShaderCache().getShaderProgram(
                    CentralBodyVSDepth,
                    '#line 0\n' +
                    CentralBodyFSDepth, {
                        position : 0
                    });
        }

        var that = this;

        // Throw exception if there was a problem asynchronously loading an image.
        if (this._exception) {
            var message = this._exception;
            this._exception = undefined;
            throw new RuntimeError(message);
        }

        // PERFORMANCE_IDEA:  Once a texture is created, it is not destroyed if
        // the corresponding show flag is turned off.  This will waste memory
        // if a user loads every texture, then sets all the flags to false.

        if (this._nightImageSource !== this.nightImageSource) {
            this._nightImageSource = this.nightImageSource;

            var nightImage = new Image();
            nightImage.onload = function() {
                that._nightTexture = that._nightTexture && that._nightTexture.destroy();
                that._nightTexture = context.createTexture2D({
                    source : nightImage,
                    pixelFormat : PixelFormat.RGB
                });
            };
            nightImage.onerror = function() {
                that._exception = 'Could not load image: ' + this.src + '.';
            };
            nightImage.src = this.nightImageSource;
        }

        if (this._specularMapSource !== this.specularMapSource) {
            this._specularMapSource = this.specularMapSource;

            var specularImage = new Image();
            specularImage.onload = function() {
                that._specularTexture = that._specularTexture && that._specularTexture.destroy();
                that._specularTexture = context.createTexture2D({
                    source : specularImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            specularImage.onerror = function() {
                that._exception = 'Could not load image: ' + this.src + '.';
            };
            specularImage.src = this.specularMapSource;
        }

        if (this._cloudsMapSource !== this.cloudsMapSource) {
            this._cloudsMapSource = this.cloudsMapSource;

            var cloudsImage = new Image();
            cloudsImage.onload = function() {
                that._cloudsTexture = that._cloudsTexture && that._cloudsTexture.destroy();
                that._cloudsTexture = context.createTexture2D({
                    source : cloudsImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            cloudsImage.onerror = function() {
                that._exception = 'Could not load image: ' + this.src + '.';
            };
            cloudsImage.src = this.cloudsMapSource;
        }

        if (this._bumpMapSource !== this.bumpMapSource) {
            this._bumpMapSource = this.bumpMapSource;

            var bumpImage = new Image();
            bumpImage.onload = function() {
                that._bumpTexture = that._bumpTexture && that._bumpTexture.destroy();
                that._bumpTexture = context.createTexture2D({
                    source : bumpImage,
                    pixelFormat : PixelFormat.LUMINANCE
                });
            };
            bumpImage.onerror = function() {
                that._exception = 'Could not load image: ' + this.src + '.';
            };
            bumpImage.src = this.bumpMapSource;
        }

        // Initial compile or re-compile if uber-shader parameters changed
        var dayChanged = ((this._showDay !== this.showDay) && (!this.showDay || this._dayTileProvider));
        var nightChanged = ((this._showNight !== this.showNight) && (!this.showNight || this._nightTexture));
        var cloudsChanged = ((this._showClouds !== this.showClouds) && (!this.showClouds || this._cloudsTexture));
        var cloudShadowsChanged = ((this._showCloudShadows !== this.showCloudShadows) && (!this.showCloudShadows || this._cloudsTexture));
        var specularChanged = ((this._showSpecular !== this.showSpecular) && (!this.showSpecular || this._specularTexture));
        var bumpsChanged = ((this._showBumps !== this.showBumps) && (!this.showBumps || this._bumpTexture));

        if (typeof this._sp === 'undefined' ||
            typeof this._northPoleCommand.shaderProgram === 'undefined' ||
            typeof this._southPoleCommand.shaderProgram === 'undefined' ||
            (dayChanged || nightChanged || cloudsChanged || cloudShadowsChanged || specularChanged || bumpsChanged) ||
            (this._showTerminator !== this.showTerminator) ||
            (this._affectedByLighting !== this.affectedByLighting)) {

            var fsPrepend = ((this.showDay && this._dayTileProvider) ? '#define SHOW_DAY 1\n' : '') +
                ((this.showNight && this._nightTexture) ? '#define SHOW_NIGHT 1\n' : '') +
                ((this.showClouds && this._cloudsTexture) ? '#define SHOW_CLOUDS 1\n' : '') +
                ((this.showCloudShadows && this._cloudsTexture) ? '#define SHOW_CLOUD_SHADOWS 1\n' : '') +
                ((this.showSpecular && this._specularTexture) ? '#define SHOW_SPECULAR 1\n' : '') +
                ((this.showBumps && this._bumpTexture) ? '#define SHOW_BUMPS 1\n' : '') +
                (this.showTerminator ? '#define SHOW_TERMINATOR 1\n' : '') +
                (this.affectedByLighting ? '#define AFFECTED_BY_LIGHTING 1\n' : '') +
                '#line 0\n' +
                CentralBodyFSCommon;
            var groundFromSpacePrepend = '#define SHOW_GROUND_ATMOSPHERE 1\n' +
                '#define SHOW_GROUND_ATMOSPHERE_FROM_SPACE 1\n';
            var groundFromAtmospherePrepend = '#define SHOW_GROUND_ATMOSPHERE 1\n' +
                '#define SHOW_GROUND_ATMOSPHERE_FROM_ATMOSPHERE 1\n';

            vs = '#line 0\n' +
                 GroundAtmosphere +
                 CentralBodyVS;

            fs = fsPrepend + CentralBodyFS;

            this._spWithoutAtmosphere = this._spWithoutAtmosphere && this._spWithoutAtmosphere.release();
            this._spGroundFromSpace = this._spGroundFromSpace && this._spGroundFromSpace.release();
            this._spGroundFromAtmosphere = this._spGroundFromAtmosphere && this._spGroundFromAtmosphere.release();

            this._spWithoutAtmosphere = context.getShaderCache().getShaderProgram(vs, fs, attributeIndices);
            this._spGroundFromSpace = context.getShaderCache().getShaderProgram(
                    groundFromSpacePrepend + vs,
                    groundFromSpacePrepend + fs,
                    attributeIndices);
            this._spGroundFromAtmosphere = context.getShaderCache().getShaderProgram(
                    groundFromAtmospherePrepend + vs,
                    groundFromAtmospherePrepend + fs,
                    attributeIndices);

            vs = CentralBodyVSPole;
            fs = fsPrepend + GroundAtmosphere + CentralBodyFSPole;

            this._spPolesWithoutAtmosphere = this._spPolesWithoutAtmosphere && this._spPolesWithoutAtmosphere.release();
            this._spPolesGroundFromSpace = this._spPolesGroundFromSpace && this._spPolesGroundFromSpace.release();
            this._spPolesGroundFromAtmosphere = this._spPolesGroundFromAtmosphere && this._spPolesGroundFromAtmosphere.release();

            this._spPolesWithoutAtmosphere = context.getShaderCache().getShaderProgram(vs, fs, attributeIndices);
            this._spPolesGroundFromSpace = context.getShaderCache().getShaderProgram(
                    vs,
                    groundFromSpacePrepend + fs,
                    attributeIndices);
            this._spPolesGroundFromAtmosphere = context.getShaderCache().getShaderProgram(
                    vs,
                    groundFromAtmospherePrepend + fs,
                    attributeIndices);

            // Sync to public state
            this._showDay = dayChanged ? this.showDay : this._showDay;
            this._showNight = nightChanged ? this.showNight : this._showNight;
            this._showClouds = cloudsChanged ? this.showClouds : this._showClouds;
            this._showCloudShadows = cloudShadowsChanged ? this.showCloudShadows : this._showCloudShadows;
            this._showSpecular = specularChanged ? this.showSpecular : this._showSpecular;
            this._showBumps = bumpsChanged ? this.showBumps : this._showBumps;
            this._showTerminator = this.showTerminator;
            this._affectedByLighting = this.affectedByLighting;
        }

        var camera = frameState.camera;
        var cameraPosition = camera.getPositionWC();

        this._fCameraHeight2 = cameraPosition.magnitudeSquared();
        this._fCameraHeight = Math.sqrt(this._fCameraHeight2);

        if (this._fCameraHeight > this._outerRadius) {
            // Viewer in space
            this._skyCommand.shaderProgram = this._spSkyFromSpace;
            if (this.showGroundAtmosphere) {
                this._sp = this._spGroundFromSpace;
                this._northPoleCommand.shaderProgram = this._southPoleCommand.shaderProgram = this._spPolesGroundFromSpace;
            } else {
                this._sp = this._spWithoutAtmosphere;
                this._northPoleCommand.shaderProgram = this._southPoleCommand.shaderProgram = this._spPolesWithoutAtmosphere;
            }
        } else {
            // after the camera passes the minimum height, there is no ground atmosphere effect
            var showAtmosphere = this._ellipsoid.cartesianToCartographic(cameraPosition).height >= this._minGroundFromAtmosphereHeight;
            if (this.showGroundAtmosphere && showAtmosphere) {
                this._sp = this._spGroundFromAtmosphere;
                this._northPoleCommand.shaderProgram = this._southPoleCommand.shaderProgram = this._spPolesGroundFromAtmosphere;
            } else {
                this._sp = this._spWithoutAtmosphere;
                this._northPoleCommand.shaderProgram = this._southPoleCommand.shaderProgram = this._spPolesWithoutAtmosphere;
            }
            this._skyCommand.shaderProgram = this._spSkyFromAtmosphere;
        }

        this._occluder.setCameraPosition(cameraPosition);

        this._fillPoles(context, frameState);

        this._throttleImages(frameState);
        this._throttleReprojection(frameState);
        this._throttleTextures(context, frameState);

        clearState.framebuffer = this._fb;
        context.clear(context.createClearState(clearState));

        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            if (this._cull(tile, frameState)) {
                continue;
            }

            if (!this._dayTileProvider || (tile.state === TileState.TEXTURE_LOADED && tile.texture && !tile.texture.isDestroyed())) {
                if ((this._dayTileProvider && tile.zoom + 1 > this._dayTileProvider.zoomMax) || !this._refine(tile, context, frameState)) {
                    this._enqueueTile(tile, context, frameState);
                } else {
                    var children = tile.getChildren();
                    for (var i = 0; i < children.length; ++i) {
                        var child = children[i];
                        if ((child.state === TileState.TEXTURE_LOADED && child.texture && !child.texture.isDestroyed())) {
                            stack.push(child);
                        } else {
                            this._enqueueTile(tile, context, frameState);
                            this._processTile(child);
                        }
                    }
                }
            } else {
                this._processTile(tile);
            }
        }

        this._mode = mode;
        this._projection = projection;

        var pass = frameState.passes;
        var commands;
        this._commandLists.removeAll();
        if (pass.color) {
            commands = this._commandLists.colorList;

            if (this.showSkyAtmosphere) {
                commands.push(this._skyCommand);
            }

            if (this._renderQueue.length !== 0) {
                var mv = frameState.camera.getViewMatrix();

                // TODO: remove once multi-frustum/depth testing is implemented
                this._renderQueue.sort(function(a, b) {
                    return a.zoom - b.zoom;
                });

                // render tiles to FBO
                var tileCommands = this._tileCommandList;
                tileCommands.length = this._renderQueue.length;
                var j = 0;
                while (this._renderQueue.length > 0) {
                    var curTile = this._renderQueue.dequeue();

                    var rtc;
                    if (this.morphTime === 1.0) {
                        rtc = curTile._drawUniforms.u_center3D();
                        curTile.mode = 0;
                    } else if (this.morphTime === 0.0) {
                        var center = curTile._drawUniforms.u_center2D();
                        rtc = new Cartesian3(0.0, center.x, center.y);
                        curTile.mode = 1;
                    } else {
                        rtc = Cartesian3.ZERO;
                        curTile.mode = 2;
                    }
                    var centerEye = mv.multiplyByVector(new Cartesian4(rtc.x, rtc.y, rtc.z, 1.0));
                    curTile.modelView = mv.setColumn(3, centerEye, curTile.modelView);

                    var command = tileCommands[j++];
                    if (typeof command === 'undefined') {
                        command = tileCommands[j - 1] = new Command();
                    }

                    command.framebuffer = this._fb;
                    command.shaderProgram = this._sp;
                    command.renderState = this._rsColor;
                    command.primitiveType = PrimitiveType.TRIANGLES;
                    command.vertexArray = curTile._extentVA;
                    command.uniformMap = curTile._drawUniforms;

                    commands.push(command);
                }

                // render quad with vertical and horizontal gaussian blur
                scratchQuadCommands.length = 0;
                this._quadV.update(context, frameState, scratchQuadCommands);
                commands.push.apply(commands, scratchQuadCommands[0].colorList);
                scratchQuadCommands.length = 0;
                this._quadH.update(context, frameState, scratchQuadCommands);
                commands.push.apply(commands, scratchQuadCommands[0].colorList);
                scratchQuadCommands.length = 0;

                // render quads to fill the poles and depth plane
                if (this._mode === SceneMode.SCENE3D) {
                    if (this._drawNorthPole) {
                        commands.push(this._northPoleCommand);
                    }
                    if (this._drawSouthPole) {
                        commands.push(this._southPoleCommand);
                    }

                    commands.push(this._depthCommand);
                }

                if (typeof this._quadLogo !== 'undefined' && !this._quadLogo.isDestroyed()) {
                    this._quadLogo.update(context, frameState, scratchQuadCommands);
                    commands.push.apply(commands, scratchQuadCommands[0].colorList);
                }
            }
        }
        if (pass.pick) {
            // Not actually pickable, but render depth-only so primitives on the backface
            // of the globe are not picked.
            commands = this._commandLists.pickList;
            commands.push(this._depthCommand);
        }

        if (!this._commandLists.empty()) {
            commandList.push(this._commandLists);
        }
    };

    CentralBody.prototype._destroyTileTree = function() {
        var stack = [this._rootTile];
        while (stack.length !== 0) {
            var tile = stack.pop();

            // remove circular reference
            tile.parent = undefined;

            // destroy vertex array
            if (tile._extentVA) {
                tile._extentVA = tile._extentVA && tile._extentVA.destroy();
            }

            // destroy texture
            if (tile.texture) {
                tile.texture = tile.texture && tile.texture.destroy();
            }

            // process children
            if (tile.children) {
                stack = stack.concat(tile.children);
            }
        }

        this._rootTile = undefined;
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof CentralBody
     *
     * @return {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see CentralBody#destroy
     */
    CentralBody.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @memberof CentralBody
     *
     * @return {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see CentralBody#isDestroyed
     *
     * @example
     * centralBody = centralBody && centralBody.destroy();
     */
    CentralBody.prototype.destroy = function() {
        this._destroyTileTree();

        this._texturePool = this._texturePool && this._texturePool.destroy();
        this._textureCache = this._textureCache && this._textureCache.destroy();

        this._fb = this._fb && this._fb.destroy();
        this._quadV = this._quadV && this._quadV.destroy();
        this._quadH = this._quadH && this._quadH.destroy();

        this._northPoleCommand.vertexArray = this._northPoleCommand.vertexArray && this._northPoleCommand.vertexArray.destroy();
        this._southPoleCommand.vertexArray = this._southPoleCommand.vertexArray && this._southPoleCommand.vertexArray.destroy();

        this._spPolesWithoutAtmosphere = this._spPolesWithoutAtmosphere && this._spPolesWithoutAtmosphere.release();
        this._spPolesGroundFromSpace = this._spPolesGroundFromSpace && this._spPolesGroundFromSpace.release();
        this._spPolesGroundFromAtmosphere = this._spPolesGroundFromAtmosphere && this._spPolesGroundFromAtmosphere.release();

        this._spWithoutAtmosphere = this._spWithoutAtmosphere && this._spWithoutAtmosphere.release();
        this._spGroundFromSpace = this._spGroundFromSpace && this._spGroundFromSpace.release();
        this._spGroundFromAtmosphere = this._spGroundFromAtmosphere && this._spGroundFromAtmosphere.release();

        this._skyCommand.vertexArray = this._skyCommand.vertexArray && this._skyCommand.vertexArray.destroy();
        this._spSkyFromSpace = this._spSkyFromSpace && this._spSkyFromSpace.release();
        this._spSkyFromAtmosphere = this._spSkyFromAtmosphere && this._spSkyFromAtmosphere.release();

        this._depthCommand.shaderProgram = this._depthCommand.shaderProgram && this._depthCommand.shaderProgram.release();
        this._depthCommand.vertexArray = this._depthCommand.vertexArray && this._depthCommand.vertexArray.destroy();

        this._nightTexture = this._nightTexture && this._nightTexture.destroy();
        this._specularTexture = this._specularTexture && this._specularTexture.destroy();
        this._cloudsTexture = this._cloudsTexture && this._cloudsTexture.destroy();
        this._bumpTexture = this._bumpTexture && this._bumpTexture.destroy();

        return destroyObject(this);
    };

    return CentralBody;
});
