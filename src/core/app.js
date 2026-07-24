import {
  Application, Entity, FILLMODE_FILL_WINDOW, RESOLUTION_AUTO,
  Vec3, Color, StandardMaterial, Texture, ADDRESS_CLAMP_TO_EDGE,
  FILTER_LINEAR, FOG_EXP2, CULLFACE_NONE, PIXELFORMAT_RGBA8,
} from 'playcanvas';

export function createApp(canvas) {
  const app = new Application(canvas, {
    graphicsDeviceOptions: {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    },
  });
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);
  app.start();
  window.addEventListener('resize', () => app.resizeCanvas());
  return app;
}

// A single entity with setEulerAngles(pitch, yaw, 0) does NOT behave like a
// standard FPS camera: PlayCanvas composes Euler angles as intrinsic X-then-
// Y-then-Z, meaning pitch is applied first (in world space) and yaw is then
// applied around the *already-pitched* frame's Y-axis — not world-up. Any
// time both are simultaneously nonzero (i.e. normal play: looking up/down
// while turning), this introduces unwanted roll — verified directly: pitch
// 60°/yaw 90° combined rotates world-up to (0.87, 0.5, 0), nowhere near
// (0,1,0). At combinations of pitch and yaw this can roll the view upside
// down entirely. The standard fix is a two-node rig: an outer node that only
// ever yaws around world Y, with a child that only ever pitches around its
// own local X — since the child's local X is inherited correctly from the
// parent's yaw, pitching it can never introduce roll.
export function createCamera(app) {
  const yawNode = new Entity('CameraYaw');
  const pitchNode = new Entity('Camera');
  pitchNode.addComponent('camera', {
    fov: 68,
    nearClip: 0.03,
    farClip: 4000,
    clearColor: new Color(0.55, 0.65, 0.7),
  });
  yawNode.addChild(pitchNode);
  app.root.addChild(yawNode);

  return {
    entity: pitchNode,
    setPosition(x, y, z) { yawNode.setPosition(x, y, z); },
    getPosition() { return yawNode.getPosition(); },
    setEulerAngles(pitch, yaw) {
      yawNode.setLocalEulerAngles(0, yaw, 0);
      pitchNode.setLocalEulerAngles(pitch, 0, 0);
    },
  };
}

// A vertical-gradient texture (top / horizon / fog-tinted bottom) painted
// onto a canvas, used both as the sky dome's emissive map and cached so we
// can repaint it cheaply whenever the settings panel changes a color.
function makeGradientTexture(app) {
  const cnv = document.createElement('canvas');
  cnv.width = 4;
  cnv.height = 128;
  const texture = new Texture(app.graphicsDevice, {
    width: cnv.width,
    height: cnv.height,
    format: PIXELFORMAT_RGBA8,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    magFilter: FILTER_LINEAR,
    minFilter: FILTER_LINEAR,
    mipmaps: false,
  });
  texture._canvas = cnv;
  return texture;
}

function paintGradient(texture, topColor, horizonColor) {
  const cnv = texture._canvas;
  const ctx = cnv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, cnv.height);
  grad.addColorStop(0, topColor);
  grad.addColorStop(0.55, horizonColor);
  grad.addColorStop(1, horizonColor);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  texture.setSource(cnv);
}

// Builds the sky: a huge inverted sphere painted with a gradient, always
// re-centered on the camera so it never appears to "orbit" as you walk.
// Combined with heavy fog this hides the sphere's silhouette entirely near
// the horizon and gives the illusion of unbounded open sky above a scene
// that is really only a few hundred splats wide.
export function createSky(app) {
  const texture = makeGradientTexture(app);
  const material = new StandardMaterial();
  material.useLighting = false;
  material.emissiveMap = texture;
  material.emissive = new Color(1, 1, 1);
  material.diffuse = new Color(0, 0, 0);
  material.cull = CULLFACE_NONE;
  material.useFog = false; // the dome paints its own horizon fade; scene fog is for the terrain/splat instead
  material.update();

  const dome = new Entity('SkyDome');
  dome.addComponent('render', {
    type: 'sphere',
    material,
    castShadows: false,
    receiveShadows: false,
  });
  dome.setLocalScale(1500, 1500, 1500);
  app.root.addChild(dome);

  // Render before everything else in the layer so it never depth-fights the
  // scene, and is never itself affected by fog (fog is applied to the splat
  // + ground instead so the dome's own color stays crisp above the fog line).
  const meshInstances = dome.render.meshInstances;
  if (meshInstances) {
    meshInstances.forEach((mi) => { mi.drawOrder = -1000; });
  }

  function setColors(topHex, horizonHex) {
    paintGradient(texture, topHex, horizonHex);
  }

  function follow(camera) {
    const p = camera.getPosition();
    dome.setPosition(p.x, p.y, p.z);
  }

  return { entity: dome, setColors, follow };
}

export function applyFog(app, { color = '#b9c8bd', density = 0.045 } = {}) {
  const fog = app.scene.fog;
  fog.type = FOG_EXP2;
  fog.color = hexToColor(color);
  fog.density = density;
}

export function hexToColor(hex) {
  const c = new Color();
  c.fromString(hex);
  return c;
}

export { Entity, Vec3, Color };
