'use client';

import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  Download, 
  Upload, 
  Sliders, 
  Activity, 
  Info, 
  Maximize2, 
  Check, 
  TrendingUp, 
  Compass,
  Cpu
} from 'lucide-react';
import { 
  PillowSimulation, 
  SimParameters 
} from '@/lib/physics/PillowSimulation';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend 
} from 'recharts';

// Preset memory foam materials
interface MaterialPreset {
  name: string;
  cnName: string;
  description: string;
  shearModulus: number; // mu (Pa)
  bulkModulus: number;  // K (Pa)
  g1: number; tau1: number;
  g2: number; tau2: number;
  g3: number; tau3: number;
}

const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    name: '55D Memory Foam',
    cnName: '55D 慢回弹记忆棉',
    description: '实测 55D 记忆棉参数：E=1800Pa、ν=0.48、μ=600Pa、λ=22000Pa，三项 Prony 慢回弹谱（0.7s / 5s / 28s），慢回弹释压。',
    shearModulus: 600.0,
    bulkModulus: 22400.0, // K = lambda + 2*mu/3 = 22000 + 400
    g1: 0.42, tau1: 0.7,
    g2: 0.28, tau2: 5.0,
    g3: 0.15, tau3: 28.0,
  },
  {
    name: 'Classic Slow-Rebound',
    cnName: '经典慢回弹记忆棉',
    description: '具有极高黏弹记忆性，受压后凹陷明显，缓慢回弹（回弹时间约 4-5 秒），极佳释压感。',
    shearModulus: 100.0,
    bulkModulus: 1000.0,
    g1: 0.45, tau1: 0.8,
    g2: 0.40, tau2: 4.5,
    g3: 0.0, tau3: 20.0,
  },
  {
    name: 'High-Resilience Elastic',
    cnName: '高弹高分子海绵',
    description: '极低迟滞与极高弹性。压力撤销后瞬间恢复原状（回弹时间 < 0.3 秒），支撑性强。',
    shearModulus: 1267.0,
    bulkModulus: 4000.0,
    g1: 0.08, tau1: 0.1,
    g2: 0.05, tau2: 0.3,
    g3: 0.0, tau3: 20.0,
  },
  {
    name: 'Gel Infused Cooling',
    cnName: '凝胶清凉记忆棉',
    description: '引入凝胶颗粒，硬度略增，回弹速度适中（约 2 秒），兼顾慢回弹贴合感与承托。',
    shearModulus: 733.0,
    bulkModulus: 2933.0,
    g1: 0.35, tau1: 0.4,
    g2: 0.35, tau2: 2.0,
    g3: 0.0, tau3: 20.0,
  },
  {
    name: 'Ultra-Soft Latex',
    cnName: '天然软乳胶',
    description: '超低剪切模量与极高体积分数，极软极Q弹。几乎无蠕变，具有非常均匀的顺应支撑。',
    shearModulus: 333.0,
    bulkModulus: 2000.0,
    g1: 0.04, tau1: 0.05,
    g2: 0.03, tau2: 0.1,
    g3: 0.0, tau3: 20.0,
  }
];

// Isolates chart rendering so a recharts error can't crash (freeze) the whole app.
class ChartErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    console.error('Chart render error (isolated):', error);
  }
  render() {
    if (this.state.hasError) {
      return <div className="flex-1 flex items-center justify-center text-[11px] text-slate-500">图表暂不可用</div>;
    }
    return this.props.children;
  }
}

export default function SimulatorPage() {
  const [mounted, setMounted] = useState(false);

  // Simulation Parameters — default is Classic slow-rebound memory foam.
  const [params, setParams] = useState<SimParameters>({
    // Neo-Hookean (Pa)
    shearModulus: 100.0,   // mu
    bulkModulus: 1000.0,   // K = lambda + 2*mu/3
    lambda: 933.0,
    // Linear-elastic descriptors
    youngModulus: 288.0,
    poissonRatio: 0.452,
    density: 55.0,
    // Prony (3 Maxwell terms)
    g1: 0.45, tau1: 0.8,
    g2: 0.40, tau2: 4.5,
    g3: 0.0, tau3: 20.0,
    // Rayleigh damping
    rayleighAlpha: 0.15,
    rayleighBeta: 0.005,
    // Derived damping used by the solver
    damping: 4.5,
    airResistance: 0.15,
    gravity: 9.8,
    timeStep: 0.016,
    subSteps: 5,
    gridX: 14,
    gridY: 7,
    gridZ: 10,
    contactStiffness: 100.0,
    groundStiffness: 1500.0,
    friction: 0.4
  });

  const [activePreset, setActivePreset] = useState<string>('Classic Slow-Rebound');
  
  // Controls & View States
  const [pillowType, setPillowType] = useState<'standard' | 'contour' | 'imported'>('contour');
  const [presserHeight, setPresserHeight] = useState<number>(10.0); // 0 to 18 cm
  const [colorMode, setColorMode] = useState<'material' | 'strain' | 'rebound'>('strain');
  const [showWireframe, setShowWireframe] = useState<boolean>(true);
  const [showParticles, setShowParticles] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [isViewportMax, setIsViewportMax] = useState<boolean>(false);
  const [anchorStyle, setAnchorStyle] = useState<'bottom' | 'corners' | 'none'>('bottom');
  const [presserShape, setPresserShape] = useState<'sphere' | 'custom' | 'anatomy'>('sphere');
  // Head–Neck–Shoulder assembly controls (anatomy mode)
  const [neckBend, setNeckBend] = useState<number>(3.0);
  const [shoulderDrop, setShoulderDrop] = useState<number>(6.0);
  const [shoulderDist, setShoulderDist] = useState<number>(10.0);
  const [headRotX, setHeadRotX] = useState<number>(0); // degrees about X
  const [headRotY, setHeadRotY] = useState<number>(0); // degrees about Y
  const [headRotZ, setHeadRotZ] = useState<number>(0); // degrees about Z (side-sleep)
  const NECK_SEGMENTS = 6;
  const [presserRadius, setPresserRadius] = useState<number>(4.2);
  const [presserMass, setPresserMass] = useState<number>(20.0); // kg for drop tests
  const [presserX, setPresserX] = useState<number>(0.0); // horizontal position (left-right)
  const [presserZ, setPresserZ] = useState<number>(1.5); // horizontal position (front-back)
  const [autoCycleActive, setAutoCycleActive] = useState<boolean>(false);
  
  // Custom STL names
  const [importedPillowName, setImportedPillowName] = useState<string>('');
  const [importedPresserName, setImportedPresserName] = useState<string>('');

  // Diagnostics
  const [fps, setFps] = useState<number>(60);
  const [stats, setStats] = useState({
    particlesCount: 0,
    springsCount: 0,
    cgIters: 0,
    totalForce: 0,
    kineticEnergy: 0,
    relaxationRate: 0
  });

  // Graph logs
  const [chartData, setChartData] = useState<any[]>([]);

  // Refs for 3D view
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<PillowSimulation | null>(null);
  
  // Three.js object references
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pillowMeshRef = useRef<THREE.Mesh | null>(null);
  const pillowWireframeRef = useRef<THREE.LineSegments | null>(null);
  const pillowPointsRef = useRef<THREE.Points | null>(null);
  const activePointIdxRef = useRef<number[]>([]);
  // Persist the imported rigid-body (presser) mesh so it survives sim rebuilds.
  const customPresserMeshRef = useRef<THREE.Mesh | null>(null);
  // Latest telemetry written by the 60fps loop; flushed to React state at low rate.
  const telemetryRef = useRef<{ fps: number; stats: any; chartData: any[] }>({
    fps: 60, stats: null, chartData: []
  });
  const presserMeshRef = useRef<THREE.Mesh | null>(null);
  const anatomyRef = useRef<{
    group: THREE.Group; head: THREE.Mesh; neck: THREE.Mesh[]; shoulder: THREE.Mesh;
    imported: boolean; headOffset?: THREE.Vector3; lowerPivot?: THREE.Group; shoulderPivot?: THREE.Group;
  } | null>(null);
  const anatomyParamsRef = useRef({ bend: 3.0, drop: 6.0, dist: 10.0 });
  const rotRef = useRef({ x: 0, y: 0, z: 0 }); // head rotation in radians (render-loop closure)
  const bedMeshRef = useRef<THREE.Mesh | null>(null);
  
  // Custom loaded mesh geometries
  const customPillowGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const customPillowMeshRef = useRef<THREE.Mesh | null>(null);
  const customPillowBoundsRef = useRef<{ min: THREE.Vector3; size: THREE.Vector3 } | null>(null);
  const customPillowRestRef = useRef<Float32Array | null>(null);

  // Bumped whenever a new pillow STL is loaded so the simulation lattice rebuilds
  const [importGeneration, setImportGeneration] = useState<number>(0);

  // Ensure client mounting
  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      setMounted(true);
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  // Flush telemetry (fps / stats / charts) from the ref to React state at a low,
  // fixed rate. Keeping this OUT of the 60fps render loop lets React process the
  // user's slider input promptly instead of being starved by the animation.
  useEffect(() => {
    if (!mounted) return;
    const id = setInterval(() => {
      const t = telemetryRef.current;
      setFps(t.fps);
      if (t.stats) setStats(t.stats);
      setChartData(t.chartData);
    }, 250);
    return () => clearInterval(id);
  }, [mounted]);



  // Sync parameters slider changes to existing simulation reference instantly
  useEffect(() => {
    if (simRef.current) {
      simRef.current.parameters = params;
      simRef.current.presser.radius = presserRadius;
      simRef.current.presser.mass = presserMass;
      // 'sphere' -> sphere contact; otherwise use the custom collider when one exists
      // (whole imported mesh for 'custom', or the Head part for 'anatomy').
      simRef.current.presser.shapeType =
        presserShape === 'sphere' ? 'sphere' : (simRef.current.presser.customMesh ? 'custom' : 'sphere');
    }
  }, [params, presserRadius, presserMass, presserShape]);

  // Keep anatomy params in a ref so the (closure-captured) render loop reads live values.
  useEffect(() => {
    anatomyParamsRef.current = { bend: neckBend, drop: shoulderDrop, dist: shoulderDist };
  }, [neckBend, shoulderDrop, shoulderDist]);

  // Head rotation (Z = side-sleep): drive both collider and visuals.
  useEffect(() => {
    const rx = (headRotX * Math.PI) / 180;
    const ry = (headRotY * Math.PI) / 180;
    const rz = (headRotZ * Math.PI) / 180;
    rotRef.current = { x: rx, y: ry, z: rz };
    if (simRef.current) simRef.current.presser.setRotation(rx, ry, rz);
  }, [headRotX, headRotY, headRotZ]);

  // Sync presser height manual slider to simulator
  useEffect(() => {
    if (simRef.current && simRef.current.presser.isControlled) {
      simRef.current.presser.prevPosition.copy(simRef.current.presser.position);
      simRef.current.presser.position.y = presserHeight;
    }
  }, [presserHeight]);

  // Sync presser horizontal (X/Z) position to the simulator instantly
  useEffect(() => {
    if (simRef.current) {
      simRef.current.presser.position.x = presserX;
      simRef.current.presser.position.z = presserZ;
      simRef.current.presser.prevPosition.x = presserX;
      simRef.current.presser.prevPosition.z = presserZ;
    }
  }, [presserX, presserZ]);

  // Presets trigger
  const applyPreset = (preset: MaterialPreset) => {
    setActivePreset(preset.name);
    setParams(prev => ({
      ...prev,
      shearModulus: preset.shearModulus,
      bulkModulus: preset.bulkModulus,
      g1: preset.g1,
      g2: preset.g2,
      g3: preset.g3,
      tau1: preset.tau1,
      tau2: preset.tau2,
      tau3: preset.tau3
    }));
  };

  // ---- Pillow STL loading (from a file upload or a default URL) ----
  const loadPillowGeometry = (contents: ArrayBuffer, name: string) => {
    if (!simRef.current) return;
    try {
      const geometry = new STLLoader().parse(contents);
      geometry.center();
      geometry.computeBoundingBox();
      const size = new THREE.Vector3();
      geometry.boundingBox!.getSize(size);
      // Scale so its widest horizontal dimension fits ~24 units.
      const scale = 24.0 / Math.max(size.x, size.z, 1e-6);
      geometry.scale(scale, scale, scale);
      geometry.computeBoundingBox();
      geometry.translate(0, -geometry.boundingBox!.min.y, 0); // bottom to y=0

      geometry.computeBoundingBox();
      const fittedBox = geometry.boundingBox!;
      const fittedSize = new THREE.Vector3();
      fittedBox.getSize(fittedSize);
      customPillowBoundsRef.current = { min: fittedBox.min.clone(), size: fittedSize.clone() };
      customPillowRestRef.current = Float32Array.from(geometry.attributes.position.array as ArrayLike<number>);
      customPillowGeoRef.current = geometry;

      setImportedPillowName(name);
      setPillowType('imported');
      setImportGeneration((g) => g + 1);
    } catch (err) {
      alert('解析枕头 STL 失败，请确保文件是正确的 STL 格式。');
      console.error(err);
    }
  };

  const handlePillowStlUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !simRef.current) return;
    const reader = new FileReader();
    reader.onload = (e) => loadPillowGeometry(e.target?.result as ArrayBuffer, file.name);
    reader.readAsArrayBuffer(file);
  };

  // ---- Presser (head) STL loading (from a file upload or a default URL) ----
  const loadPresserGeometry = (contents: ArrayBuffer, name: string) => {
    if (!simRef.current) return;
    try {
      const geometry = new STLLoader().parse(contents);
      geometry.center();
      geometry.computeBoundingBox();
      const size = new THREE.Vector3();
      geometry.boundingBox!.getSize(size);
      const scale = 16.0 / Math.max(size.x, size.y, size.z, 1e-6);
      geometry.scale(scale, scale, scale);

      const mat = new THREE.MeshStandardMaterial({ color: 0xf1c4a8, roughness: 0.5, metalness: 0.1 });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;

      if (sceneRef.current && presserMeshRef.current) sceneRef.current.remove(presserMeshRef.current);
      simRef.current!.presser.setCustomMesh(mesh);
      customPresserMeshRef.current = mesh;
      presserMeshRef.current = mesh;
      if (sceneRef.current) sceneRef.current.add(mesh);

      setImportedPresserName(name);
      setPresserShape('custom');
    } catch (err) {
      alert('解析刚体 STL 失败，请确保文件是正确的 STL 格式。');
      console.error(err);
    }
  };

  const handlePresserStlUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !simRef.current) return;
    const reader = new FileReader();
    reader.onload = (e) => loadPresserGeometry(e.target?.result as ArrayBuffer, file.name);
    reader.readAsArrayBuffer(file);
  };

  // Load the default project models once the simulation exists.
  const defaultsLoadedRef = useRef(false);
  useEffect(() => {
    if (!mounted || defaultsLoadedRef.current) return;
    defaultsLoadedRef.current = true;
    let cancelled = false;
    const load = async () => {
      try {
        const [pillowBuf, headBuf] = await Promise.all([
          fetch('/default-pillow.stl').then((r) => r.arrayBuffer()),
          fetch('/default-head.stl').then((r) => r.arrayBuffer()),
        ]);
        if (cancelled) return;
        // Wait until the sim/scene are ready (created by the setup effect).
        const tryLoad = () => {
          if (!simRef.current || !sceneRef.current) { setTimeout(tryLoad, 60); return; }
          loadPresserGeometry(headBuf, '人头模型(1).stl');
          loadPillowGeometry(pillowBuf, '便携枕模型0626(1).stl');
        };
        tryLoad();
      } catch (err) {
        console.error('默认模型加载失败:', err);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [mounted]);

  // STL Export deformed pillow mesh
  const handleStlExport = () => {
    if (!simRef.current) return;
    const isImported = pillowType === 'imported' && customPillowGeoRef.current !== null;
    const stlStr = simRef.current.exportToStlString(isImported ? 'imported' : 'lattice');
    
    const blob = new Blob([stlStr], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `deformed_memory_pillow_${pillowType}.stl`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // 3D Scene Setup
  const setupThreeScene = () => {
    if (!containerRef.current || !simRef.current) return;

    // Remove old canvas if exists
    containerRef.current.innerHTML = '';

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight || 500;

    // 1. Create Scene & Camera
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a); // Deep slate background (highly elegant)
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000);
    camera.position.set(0, 18, 35);

    // 2. Create Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 3. Add Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // Don't go below floor
    controls.minDistance = 10;
    controls.maxDistance = 100;

    // 4. Lights
    const ambientLight = new THREE.AmbientLight(0x334155, 1.2);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xf8fafc, 1.8);
    dirLight1.position.set(15, 30, 15);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    dirLight1.shadow.camera.near = 0.5;
    dirLight1.shadow.camera.far = 100;
    const d = 25;
    dirLight1.shadow.camera.left = -d;
    dirLight1.shadow.camera.right = d;
    dirLight1.shadow.camera.top = d;
    dirLight1.shadow.camera.bottom = -d;
    dirLight1.shadow.bias = -0.0005;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x38bdf8, 0.6); // Soft blue rim light
    dirLight2.position.set(-15, 10, -15);
    scene.add(dirLight2);

    // 5. Floor/Bed Grid Helper & Shadow Receiver Plane
    const gridHelper = new THREE.GridHelper(60, 30, 0x475569, 0x334155);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    const floorGeo = new THREE.PlaneGeometry(100, 100);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.4 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    scene.add(floor);

    // Base Bed frame
    const bedGeo = new THREE.BoxGeometry(40, 0.8, 30);
    const bedMat = new THREE.MeshStandardMaterial({ 
      color: 0x1e293b, 
      roughness: 0.7, 
      metalness: 0.2 
    });
    const bed = new THREE.Mesh(bedGeo, bedMat);
    bed.position.y = -0.4;
    bed.receiveShadow = true;
    scene.add(bed);
    bedMeshRef.current = bed;

    // 6. Build Pillow Representation
    rebuildVisualPillow();

    // 7. Create Rigid Presser
    rebuildVisualPresser();

    // 8. Animation/Sim Loop
    let lastTime = 0;
    let frameCount = 0;
    let fpsTimer = 0;

    const num = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);

    const animate = () => {
      const animationFrameId = requestAnimationFrame(animate);

      const now = performance.now();
      if (lastTime === 0) lastTime = now;
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      // FPS (stored, not setState — see telemetry interval below)
      frameCount++;
      fpsTimer += delta;
      if (fpsTimer >= 0.5) {
        telemetryRef.current.fps = Math.round(frameCount / fpsTimer);
        frameCount = 0;
        fpsTimer = 0;
      }

      // Physics loop step
      if (!isPaused && simRef.current) {
        simRef.current.step(params.timeStep);
      }

      // Store telemetry in a ref ONLY. React state is pushed by a low-frequency
      // interval (below); driving setState from this 60fps loop starves React's
      // discrete user-input updates (e.g. the mass slider would never re-render).
      if (simRef.current) {
        const sim = simRef.current;
        telemetryRef.current.stats = {
          particlesCount: sim.particles.length,
          springsCount: sim.springs.length,
          cgIters: sim.cgIterations,
          totalForce: num(Number(sim.totalReactionForce.toFixed(1))),
          kineticEnergy: num(Number(sim.totalKineticEnergy.toFixed(3))),
          relaxationRate: num(Number((sim.totalReactionForce > 0.1 ?
            sim.totalReactionForce / (params.shearModulus + params.bulkModulus) : 0).toFixed(3)))
        };
        telemetryRef.current.chartData = sim.forceHistory.filter(d =>
          Number.isFinite(d.time) && Number.isFinite(d.displacement) &&
          Number.isFinite(d.force) && Number.isFinite(d.energy));
      }

      // Sync physical states to visual Three.js geometries
      updateVisuals();

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    // Handle container resize
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width: w, height: h } = entries[0].contentRect;
      if (rendererRef.current && camera) {
        rendererRef.current.setSize(w, h || 500);
        camera.aspect = w / (h || 500);
        camera.updateProjectionMatrix();
      }
    });
    resizeObserver.observe(containerRef.current);
  };

  // Generates smooth BufferGeometry for standard/contour pillow lattice
  const rebuildVisualPillow = () => {
    const scene = sceneRef.current;
    const sim = simRef.current;
    if (!scene || !sim) return;

    // Remove old models
    if (pillowMeshRef.current) scene.remove(pillowMeshRef.current);
    if (pillowWireframeRef.current) scene.remove(pillowWireframeRef.current);
    if (pillowPointsRef.current) scene.remove(pillowPointsRef.current);
    if (customPillowMeshRef.current) scene.remove(customPillowMeshRef.current);

    const isImported = pillowType === 'imported' && customPillowGeoRef.current !== null;

    if (isImported) {
      // 1. Render beautiful custom high-resolution STL pillow mesh
      const geo = customPillowGeoRef.current!;
      
      // We will color vertices of custom geometry based on skinning strain!
      const vertexCount = geo.attributes.position.count;
      const colors = new Float32Array(vertexCount * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.MeshStandardMaterial({
        roughness: 0.6,
        metalness: 0.1,
        vertexColors: true,
        shadowSide: THREE.DoubleSide
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      customPillowMeshRef.current = mesh;

      // Update mesh deform weights initial
      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      sim.updateStlMeshDeformation(posAttr);
    } 

    // Always create structural visualizer for the simulated core grid
    // 2. Build explicit surface triangulation geometry of the lattice
    const { gridX, gridY, gridZ } = params;
    const geo = new THREE.BufferGeometry();

    // Generate vertex coordinates array
    const vertices = new Float32Array(sim.particles.length * 3);
    const colors = new Float32Array(sim.particles.length * 3);
    
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i].position;
      vertices[i * 3] = p.x;
      vertices[i * 3 + 1] = p.y;
      vertices[i * 3 + 2] = p.z;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Define surface index list
    const getIndex = (x: number, y: number, z: number) => {
      return x * (gridY * gridZ) + y * gridZ + z;
    };

    const indices: number[] = [];
    const addTri = (i1: number, i2: number, i3: number) => {
      indices.push(i1, i2, i3);
    };
    const addQuad = (i1: number, i2: number, i3: number, i4: number) => {
      addTri(i1, i2, i3);
      addTri(i1, i3, i4);
    };

    // Bottom face (y=0)
    for (let x = 0; x < gridX - 1; x++) {
      for (let z = 0; z < gridZ - 1; z++) {
        addQuad(getIndex(x, 0, z), getIndex(x, 0, z + 1), getIndex(x + 1, 0, z + 1), getIndex(x + 1, 0, z));
      }
    }
    // Top face (y=gridY-1)
    for (let x = 0; x < gridX - 1; x++) {
      for (let z = 0; z < gridZ - 1; z++) {
        addQuad(getIndex(x, gridY - 1, z), getIndex(x + 1, gridY - 1, z), getIndex(x + 1, gridY - 1, z + 1), getIndex(x, gridY - 1, z + 1));
      }
    }
    // Front face (z=gridZ-1)
    for (let x = 0; x < gridX - 1; x++) {
      for (let y = 0; y < gridY - 1; y++) {
        addQuad(getIndex(x, y, gridZ - 1), getIndex(x + 1, y, gridZ - 1), getIndex(x + 1, y + 1, gridZ - 1), getIndex(x, y + 1, gridZ - 1));
      }
    }
    // Back face (z=0)
    for (let x = 0; x < gridX - 1; x++) {
      for (let y = 0; y < gridY - 1; y++) {
        addQuad(getIndex(x, y, 0), getIndex(x, y + 1, 0), getIndex(x + 1, y + 1, 0), getIndex(x + 1, y, 0));
      }
    }
    // Left face (x=0)
    for (let y = 0; y < gridY - 1; y++) {
      for (let z = 0; z < gridZ - 1; z++) {
        addQuad(getIndex(0, y, z), getIndex(0, y + 1, z), getIndex(0, y + 1, z + 1), getIndex(0, y, z + 1));
      }
    }
    // Right face (x=gridX-1)
    for (let y = 0; y < gridY - 1; y++) {
      for (let z = 0; z < gridZ - 1; z++) {
        addQuad(getIndex(gridX - 1, y, z), getIndex(gridX - 1, y, z + 1), getIndex(gridX - 1, y + 1, z + 1), getIndex(gridX - 1, y + 1, z));
      }
    }

    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.1,
      vertexColors: true,
      shadowSide: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    
    if (!isImported) {
      scene.add(mesh);
      pillowMeshRef.current = mesh;
    } else {
      // Keep it hidden unless we toggle it
      pillowMeshRef.current = mesh;
    }

    // 3. Build wireframe lines
    const lineIndices: number[] = [];
    sim.springs.forEach(spring => {
      // Show structural edges
      if (spring.type === 'structural') {
        lineIndices.push(spring.pA, spring.pB);
      }
    });

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    lineGeo.setIndex(lineIndices);

    const lineMat = new THREE.LineBasicMaterial({ 
      color: 0x38bdf8, 
      transparent: true, 
      opacity: 0.35,
      depthWrite: false
    });
    const wireframe = new THREE.LineSegments(lineGeo, lineMat);
    
    if (showWireframe) {
      scene.add(wireframe);
    }
    pillowWireframeRef.current = wireframe;

    // 4. Build point particles visualizer (only ACTIVE nodes, so the overlay
    // reflects the real lattice shape rather than the full bounding box).
    const activeIdx: number[] = [];
    for (let i = 0; i < sim.particles.length; i++) {
      if (sim.particles[i].active) activeIdx.push(i);
    }
    activePointIdxRef.current = activeIdx;
    const pointPositions = new Float32Array(activeIdx.length * 3);
    for (let k = 0; k < activeIdx.length; k++) {
      const p = sim.particles[activeIdx[k]].position;
      pointPositions[k * 3] = p.x;
      pointPositions[k * 3 + 1] = p.y;
      pointPositions[k * 3 + 2] = p.z;
    }
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
    const pointMat = new THREE.PointsMaterial({ 
      color: 0xf43f5e, 
      size: 0.3, 
      transparent: true, 
      opacity: 0.8 
    });
    const points = new THREE.Points(pointGeo, pointMat);
    if (showParticles) {
      scene.add(points);
    }
    pillowPointsRef.current = points;
  };

  const rebuildVisualPresser = () => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (presserMeshRef.current) {
      scene.remove(presserMeshRef.current);
    }
    if (anatomyRef.current) {
      scene.remove(anatomyRef.current.group);
      anatomyRef.current = null;
    }

    if (presserShape === 'anatomy') {
      const headMat = new THREE.MeshStandardMaterial({ color: 0xf1c4a8, roughness: 0.6, metalness: 0.05 });
      const neckMat = new THREE.MeshStandardMaterial({ color: 0xdca88a, roughness: 0.6, metalness: 0.05 });
      const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.2 });

      const src = customPresserMeshRef.current;
      if (src) {
        // ---- Split the IMPORTED model into Head / Neck / Shoulder by height ----
        const pos = src.geometry.getAttribute('position').array as ArrayLike<number>;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) minY = pos[i]; if (pos[i] > maxY) maxY = pos[i]; }
        const range = Math.max(1e-6, maxY - minY);
        const tShoulder = minY + 0.30 * range; // below -> shoulder
        const tHead = minY + 0.58 * range;     // above -> head; between -> neck

        const headArr: number[] = [], neckArr: number[] = [], shArr: number[] = [];
        for (let t = 0; t < pos.length; t += 9) {
          const cy = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
          const dst = cy >= tHead ? headArr : cy >= tShoulder ? neckArr : shArr;
          for (let k = 0; k < 9; k++) dst.push(pos[t + k]);
        }
        const mkGeo = (arr: number[]) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
          g.computeVertexNormals();
          return g;
        };
        const headGeo = mkGeo(headArr.length ? headArr : Array.from(pos));
        const neckGeo = mkGeo(neckArr);
        const shGeo = mkGeo(shArr);

        const centerOf = (g: THREE.BufferGeometry) => { g.computeBoundingBox(); const c = new THREE.Vector3(); g.boundingBox!.getCenter(c); return c; };
        const headCenter = centerOf(headGeo);
        src.geometry.computeBoundingBox();
        const gc = new THREE.Vector3(); src.geometry.boundingBox!.getCenter(gc);
        const boundaryHN = new THREE.Vector3(gc.x, tHead, gc.z);
        const boundaryNS = new THREE.Vector3(gc.x, tShoulder, gc.z);

        // Everything is shifted by -headCenter so the group's origin IS the head
        // centre; then group.position = presser.position and group.rotation.y (yaw)
        // rotates the whole assembly about the head for side-sleep testing.
        const group = new THREE.Group();
        const head = new THREE.Mesh(headGeo, headMat); head.castShadow = true; head.receiveShadow = true;
        head.position.copy(headCenter).negate();
        group.add(head);

        const lowerPivot = new THREE.Group(); lowerPivot.position.copy(boundaryHN).sub(headCenter); group.add(lowerPivot);
        const neckMesh = new THREE.Mesh(neckGeo, neckMat); neckMesh.castShadow = true; neckMesh.position.copy(boundaryHN).negate(); lowerPivot.add(neckMesh);

        const shoulderPivot = new THREE.Group(); shoulderPivot.position.copy(boundaryNS.clone().sub(boundaryHN)); lowerPivot.add(shoulderPivot);
        const shoulder = new THREE.Mesh(shGeo, shoulderMat); shoulder.castShadow = true;
        // shoulderPivot sits (unrotated) at world boundaryNS; offset the mesh so its
        // original-coord vertices render in place.
        shoulder.position.copy(boundaryNS).multiplyScalar(-1);
        shoulderPivot.add(shoulder);

        scene.add(group);

        // Head part becomes the pillow collider (recentered to origin = presser.position).
        const headColliderGeo = headGeo.clone();
        headColliderGeo.translate(-headCenter.x, -headCenter.y, -headCenter.z);
        if (simRef.current) simRef.current.presser.setCustomMesh(new THREE.Mesh(headColliderGeo));

        anatomyRef.current = { group, head, neck: [neckMesh], shoulder, imported: true, headOffset: headCenter, lowerPivot, shoulderPivot };
        presserMeshRef.current = null;
        return;
      }

      // ---- Fallback: procedural Head + segmented Neck + Shoulder ----
      const group = new THREE.Group();
      const head = new THREE.Mesh(new THREE.SphereGeometry(presserRadius, 32, 32), headMat);
      head.castShadow = true; head.receiveShadow = true; group.add(head);
      const neck: THREE.Mesh[] = [];
      for (let i = 0; i < NECK_SEGMENTS; i++) {
        const r = presserRadius * (0.55 - 0.02 * i);
        const seg = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.5, r), 20, 20), neckMat);
        seg.castShadow = true; seg.receiveShadow = true; group.add(seg); neck.push(seg);
      }
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(presserRadius * 3.2, presserRadius * 1.4, presserRadius * 1.8), shoulderMat);
      shoulder.castShadow = true; shoulder.receiveShadow = true; group.add(shoulder);
      scene.add(group);
      if (simRef.current) simRef.current.presser.customMesh = null; // procedural head uses sphere contact
      anatomyRef.current = { group, head, neck, shoulder, imported: false };
      presserMeshRef.current = null;
      return;
    }

    if (presserShape === 'sphere') {
      const geo = new THREE.SphereGeometry(presserRadius, 32, 32);
      const mat = new THREE.MeshStandardMaterial({ 
        color: 0xf43f5e, // Rose accent red for the presser
        roughness: 0.3, 
        metalness: 0.5 
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      presserMeshRef.current = mesh;
    } else {
      // Re-use loaded custom presser if available
      if (simRef.current && simRef.current.presser.customMesh) {
        presserMeshRef.current = simRef.current.presser.customMesh;
        scene.add(presserMeshRef.current);
      } else {
        // Fallback cylinder presser
        const geo = new THREE.CylinderGeometry(presserRadius, presserRadius, 4.0, 32);
        const mat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, roughness: 0.3 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        presserMeshRef.current = mesh;
      }
    }
  };

  // Synchronizes physical state variables to webgl geometry buffer attributes
  const updateVisuals = () => {
    const sim = simRef.current;
    if (!sim) return;

    // 1. Update Presser position in 3D scene
    if (presserMeshRef.current) {
      presserMeshRef.current.position.copy(sim.presser.position);
      presserMeshRef.current.rotation.set(rotRef.current.x, rotRef.current.y, rotRef.current.z);
    }

    // 1b. Anatomy assembly: head follows the physical presser; neck bends from the
    // head down to the shoulder along a quadratic Bézier (multi-joint look).
    if (anatomyRef.current) {
      const a = anatomyRef.current;
      const { bend, drop, dist } = anatomyParamsRef.current;
      const head = sim.presser.position;

      if (a.imported && a.lowerPivot && a.shoulderPivot) {
        // Group origin is the head centre: place it at the presser point, yaw about
        // Y for side-sleep, and articulate the neck/shoulder joints via bend.
        a.group.position.copy(head);
        a.group.rotation.set(rotRef.current.x, rotRef.current.y, rotRef.current.z);
        const bendRad = bend * 0.06; // map slider to radians
        a.lowerPivot.rotation.x = bendRad;
        a.shoulderPivot.rotation.x = bendRad * 0.6;
      } else {
        // Procedural fallback: head sphere + Bézier neck to a shoulder box.
        a.head.position.copy(head);
        const sx = head.x;
        const sy = Math.max(presserRadius, head.y - drop);
        const sz = head.z + dist;
        a.shoulder.position.set(sx, sy - presserRadius * 0.7, sz);
        const p0 = head;
        const p2x = sx, p2y = sy, p2z = sz;
        const cx = (p0.x + p2x) / 2;
        const cy = (p0.y + p2y) / 2 + bend;
        const cz = (p0.z + p2z) / 2 - bend * 0.5;
        const n = a.neck.length;
        for (let i = 0; i < n; i++) {
          const t = (i + 1) / (n + 1);
          const mt = 1 - t;
          a.neck[i].position.set(
            mt * mt * p0.x + 2 * mt * t * cx + t * t * p2x,
            mt * mt * p0.y + 2 * mt * t * cy + t * t * p2y,
            mt * mt * p0.z + 2 * mt * t * cz + t * t * p2z,
          );
        }
      }
    }

    const isImported = pillowType === 'imported' && customPillowGeoRef.current !== null;

    // 2. Update Pillow Surface Mesh Position and Colors
    if (pillowMeshRef.current) {
      const geo = pillowMeshRef.current.geometry;
      const positions = geo.attributes.position.array as Float32Array;
      const colors = geo.attributes.color.array as Float32Array;

      for (let i = 0; i < sim.particles.length; i++) {
        const p = sim.particles[i].position;
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;

        // Apply visual stress strain gradients
        let r = 0.95, g = 0.93, b = 0.86; // standard latex foam color
        if (colorMode === 'strain') {
          const s = sim.particles[i].strain;
          // Deep Blue (unstretched) -> Green -> Red (highly strained)
          if (s < 0.5) {
            const t = s * 2;
            r = 0.1 * (1 - t) + 0.1 * t;
            g = 0.2 * (1 - t) + 0.9 * t;
            b = 0.8 * (1 - t) + 0.1 * t;
          } else {
            const t = (s - 0.5) * 2;
            r = 0.1 * (1 - t) + 0.94 * t;
            g = 0.9 * (1 - t) + 0.25 * t;
            b = 0.1 * (1 - t) + 0.2 * t;
          }
        } else if (colorMode === 'rebound') {
          // Rebound map based on recovery velocity (upwards velocity)
          const velY = Math.max(0, sim.particles[i].velocity.y);
          const s = Math.min(1.0, velY / 15.0);
          r = 0.95 * (1 - s) + 0.05 * s;
          g = 0.93 * (1 - s) + 0.85 * s;
          b = 0.86 * (1 - s) + 0.3 * s;
        }

        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }

      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.computeVertexNormals();
    }

    // 3. Update Custom Imported STL Geometry if active
    if (isImported && customPillowGeoRef.current) {
      const geo = customPillowGeoRef.current;
      const posAttr = geo.attributes.position as THREE.BufferAttribute;
      const colors = geo.attributes.color.array as Float32Array;

      // Deform high-resolution mesh from the low-resolution physical lattice
      sim.updateStlMeshDeformation(posAttr);

      // Map skinning deformation colors
      const count = posAttr.count;
      const tempV = new THREE.Vector3();

      for (let i = 0; i < count; i++) {
        tempV.fromBufferAttribute(posAttr, i);
        // Find nearest particle to color code local strain
        const skin = sim.stlSkinningData[i];
        let localStrain = 0;
        if (skin) {
          for (let j = 0; j < skin.indices.length; j++) {
            localStrain += sim.particles[skin.indices[j]].strain * skin.weights[j];
          }
        }

        let r = 0.96, g = 0.94, b = 0.88;
        if (colorMode === 'strain') {
          const s = Math.min(1.0, localStrain * 2.5);
          if (s < 0.5) {
            const t = s * 2;
            r = 0.1 * (1 - t) + 0.1 * t;
            g = 0.2 * (1 - t) + 0.9 * t;
            b = 0.8 * (1 - t) + 0.1 * t;
          } else {
            const t = (s - 0.5) * 2;
            r = 0.1 * (1 - t) + 0.94 * t;
            g = 0.9 * (1 - t) + 0.25 * t;
            b = 0.1 * (1 - t) + 0.2 * t;
          }
        } else if (colorMode === 'rebound') {
          // Average upward velocity for this skinned vertex
          let avgVelY = 0;
          if (skin) {
            for (let j = 0; j < skin.indices.length; j++) {
              avgVelY += sim.particles[skin.indices[j]].velocity.y * skin.weights[j];
            }
          }
          const s = Math.min(1.0, Math.max(0, avgVelY) / 10.0);
          r = 0.96 * (1 - s) + 0.05 * s;
          g = 0.94 * (1 - s) + 0.85 * s;
          b = 0.88 * (1 - s) + 0.3 * s;
        }

        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      geo.attributes.color.needsUpdate = true;
      geo.computeVertexNormals();
    }

    // 4. Update Wireframe Position Buffer
    if (pillowWireframeRef.current && showWireframe) {
      const geo = pillowWireframeRef.current.geometry;
      const positions = geo.attributes.position.array as Float32Array;
      for (let i = 0; i < sim.particles.length; i++) {
        const p = sim.particles[i].position;
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
      }
      geo.attributes.position.needsUpdate = true;
    }

    // 5. Update Point Particles Position Buffer (active nodes only)
    if (pillowPointsRef.current && showParticles) {
      const geo = pillowPointsRef.current.geometry;
      const positions = geo.attributes.position.array as Float32Array;
      const idxs = activePointIdxRef.current;
      for (let k = 0; k < idxs.length; k++) {
        const p = sim.particles[idxs[k]].position;
        positions[k * 3] = p.x;
        positions[k * 3 + 1] = p.y;
        positions[k * 3 + 2] = p.z;
      }
      geo.attributes.position.needsUpdate = true;
    }
  };

  // Initialize and rebuild simulation when grid dimensions or presets change
  useEffect(() => {
    if (!mounted) return;
    
    // Create new simulation
    const sim = new PillowSimulation(params);
    sim.anchorStyle = anchorStyle;
    sim.presser.shapeType = presserShape === 'custom' ? 'custom' : 'sphere';
    sim.presser.radius = presserRadius;
    sim.presser.mass = presserMass;
    // Restore the imported rigid-body collision mesh (a fresh sim has none, which
    // would leave a custom presser without any contact — it would just hover).
    if (presserShape === 'custom' && customPresserMeshRef.current) {
      sim.presser.setCustomMesh(customPresserMeshRef.current);
    }

    const isImported =
      pillowType === 'imported' &&
      customPillowGeoRef.current !== null &&
      customPillowBoundsRef.current !== null;

    if (isImported) {
      // Regenerate the structural lattice + all particles to fit the actual model.
      // The triangle soup drives a point-in-mesh test so the grid conforms to
      // irregular (non-box) pillow shapes, then the mesh is skinned onto it.
      const posAttr = customPillowGeoRef.current!.attributes.position as THREE.BufferAttribute;
      // Restore pristine vertices so binding/skinning starts from the original model.
      if (customPillowRestRef.current && customPillowRestRef.current.length === posAttr.array.length) {
        (posAttr.array as Float32Array).set(customPillowRestRef.current);
        posAttr.needsUpdate = true;
      }
      sim.modelBounds = customPillowBoundsRef.current;
      // Use the pristine vertex copy for the point-in-mesh test (the live buffer is
      // deformed every frame, which would corrupt later rebuilds).
      sim.modelPositions = (customPillowRestRef.current ?? posAttr.array) as ArrayLike<number>;
      sim.resetPillow('contour');
      sim.bindStlMesh(posAttr);
    } else {
      sim.modelBounds = null;
      sim.modelPositions = null;
      sim.resetPillow(pillowType === 'imported' ? 'contour' : pillowType);
    }
    
    // Position presser initial
    sim.presser.position.set(presserX, presserHeight, presserZ);
    sim.presser.prevPosition.copy(sim.presser.position);
    
    simRef.current = sim;

    const frameId = requestAnimationFrame(() => {
      setStats(prev => ({
        ...prev,
        particlesCount: sim.particles.length,
        springsCount: sim.springs.length
      }));
    });

    // Setup 3D objects in Three.js scene
    setupThreeScene();

    return () => {
      cancelAnimationFrame(frameId);
      // Clean up renderer on recreation
      if (rendererRef.current && rendererRef.current.domElement) {
        rendererRef.current.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, params.gridX, params.gridY, params.gridZ, pillowType, anchorStyle, importGeneration]);

  // Drop Test Mode Trigger
  const triggerDropTest = () => {
    if (!simRef.current) return;
    simRef.current.presser.isControlled = false;
    simRef.current.presser.autoCycleActive = false;
    simRef.current.presser.velocity.set(0, -10.0, 0); // Give initial downward drop speed
    simRef.current.presser.position.set(presserX, 14.0, presserZ); // Drop from 14 cm at chosen XZ
    setPresserHeight(14.0);
    setAutoCycleActive(false);
  };

  // Cyclic Hysteresis Test Mode Trigger
  const toggleCyclicTest = () => {
    if (!simRef.current) return;
    const nextState = !simRef.current.presser.autoCycleActive;
    simRef.current.presser.autoCycleActive = nextState;
    simRef.current.presser.isControlled = !nextState;
    setAutoCycleActive(nextState);
    if (nextState) {
      simRef.current.presser.autoCycleCenterY = 7.5;
      simRef.current.presser.autoCycleAmplitude = 3.5;
    }
  };

  // Reset pillow & clear compression history logs
  const resetSimulation = () => {
    if (simRef.current) {
      simRef.current.resetPillow(pillowType === 'imported' ? 'contour' : pillowType);
      simRef.current.presser.isControlled = true;
      simRef.current.presser.autoCycleActive = false;
      simRef.current.presser.position.set(presserX, 10.0, presserZ);
      simRef.current.presser.velocity.set(0, 0, 0);
      setPresserHeight(10.0);
      setAutoCycleActive(false);
      setChartData([]);
    }
  };

  // Toggle wireframe view
  const toggleWireframe = (val: boolean) => {
    setShowWireframe(val);
    if (!sceneRef.current || !pillowWireframeRef.current) return;
    if (val) {
      sceneRef.current.add(pillowWireframeRef.current);
    } else {
      sceneRef.current.remove(pillowWireframeRef.current);
    }
  };

  // Toggle particles view
  const toggleParticles = (val: boolean) => {
    setShowParticles(val);
    if (!sceneRef.current || !pillowPointsRef.current) return;
    if (val) {
      sceneRef.current.add(pillowPointsRef.current);
    } else {
      sceneRef.current.remove(pillowPointsRef.current);
    }
  };

  if (!mounted) return <div className="text-white bg-slate-950 min-h-screen flex items-center justify-center">Loading WebGL Environment...</div>;

  return (
    <div className="notranslate bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans selection:bg-rose-500/30 overflow-x-hidden" id="app_root" translate="no">

      {/* Dynamic Upper Header Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-40" id="header">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-rose-500/10 rounded-lg border border-rose-500/20 text-rose-400">
            <Cpu className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
              Pillow Compression Workbench <span className="text-xs font-mono font-normal text-rose-400 px-2 py-0.5 bg-rose-950/40 border border-rose-800/30 rounded-full ml-2">Implicit Prony Engine</span>
            </h1>
            <p className="text-xs text-slate-400">基于 Neo-Hookean 超弹性与 Prony  Prony series 黏弹性的慢回弹枕头受压及凹陷模拟系统</p>
          </div>
        </div>
        
        {/* Real-time Performance Indicator panel */}
        <div className="flex items-center space-x-6 text-xs font-mono" id="perf_stats">
          <div className="bg-slate-950/60 border border-slate-800/80 rounded px-3 py-1.5 flex items-center space-x-2">
            <span className="text-slate-500">Solver:</span>
            <span className="text-emerald-400 font-bold">Implicit Euler</span>
          </div>
          <div className="bg-slate-950/60 border border-slate-800/80 rounded px-3 py-1.5 flex items-center space-x-2">
            <span className="text-slate-500">CG-Iters:</span>
            <span className="text-sky-400">{stats.cgIters}</span>
          </div>
          <div className="bg-slate-950/60 border border-slate-800/80 rounded px-3 py-1.5 flex items-center space-x-2">
            <span className="text-slate-500">Performance:</span>
            <span className={`${fps >= 50 ? 'text-emerald-400' : 'text-amber-400'}`}>{fps} FPS</span>
          </div>
        </div>
      </header>

      {/* Main Workbench Desktop Layout */}
      <main className="flex-1 grid grid-cols-1 xl:grid-cols-12 gap-5 p-5 max-w-[1700px] w-full mx-auto" id="main_desktop">
        
        {/* LEFT COLUMN: Controls, Presets & Boundary Params (Width 4/12) */}
        <div className="xl:col-span-4 flex flex-col space-y-5 overflow-y-auto max-h-[calc(100vh-120px)] pr-2" id="left_col">
          
          {/* Preset Material Foam Blocks */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg" id="material_presets_section">
            <div className="flex items-center space-x-2 mb-4">
              <Compass className="w-5 h-5 text-rose-400" />
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">材质配方预设 / Presets</h2>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {MATERIAL_PRESETS.map((preset) => {
                const isActive = activePreset === preset.name;
                return (
                  <button
                    key={preset.name}
                    onClick={() => applyPreset(preset)}
                    className={`p-3 rounded-lg text-left transition-all border text-xs flex flex-col justify-between h-24 relative overflow-hidden group ${
                      isActive 
                        ? 'bg-rose-950/20 border-rose-500/50 text-white shadow-md' 
                        : 'bg-slate-950/40 border-slate-800/80 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-slate-100 flex items-center justify-between">
                        <span>{preset.cnName}</span>
                        {isActive && <Check className="w-3.5 h-3.5 text-rose-400" />}
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1 leading-relaxed line-clamp-2">
                        {preset.description}
                      </p>
                    </div>
                    {/* Tiny background design elements */}
                    <div className="absolute right-1 bottom-1 opacity-10 group-hover:opacity-20 transition-all font-mono text-[10px]">
                      {preset.shearModulus} kPa
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Core Elasticity & Viscoelasticity Settings */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-5" id="simulation_params_section">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <Sliders className="w-5 h-5 text-rose-400" />
                <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">物理引擎与材料参数</h2>
              </div>
              <button 
                onClick={() => { setActivePreset('Classic Slow-Rebound'); setParams(prev => ({ ...prev, shearModulus: 100, bulkModulus: 1000, lambda: 933, youngModulus: 288, poissonRatio: 0.452, density: 55, g1: 0.45, tau1: 0.8, g2: 0.40, tau2: 4.5, g3: 0.0, tau3: 20.0, rayleighAlpha: 0.15, rayleighBeta: 0.005, damping: 4.5, airResistance: 0.15 })); }}
                className="text-[10px] hover:text-rose-400 transition text-slate-500 flex items-center space-x-1"
              >
                <RotateCcw className="w-3 h-3" />
                <span>重置参数</span>
              </button>
            </div>

            {/* Hyperelastic Neo-Hookean parameters */}
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-300 flex items-center justify-between">
                <span>1. Neo-Hookean 超弹性剪切与体积模量</span>
                <span className="text-[10px] text-rose-400 font-mono">μ & K Moduli</span>
              </h3>
              
              <div className="space-y-3 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400">剪切模量 (μ / Shear Modulus)</span>
                    <span className="font-mono text-rose-400 font-semibold">{params.shearModulus} Pa</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="2000"
                    step="10"
                    value={params.shearModulus}
                    onChange={(e) => {
                      setParams({ ...params, shearModulus: parseFloat(e.target.value) });
                      setActivePreset('Custom');
                    }}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">控制海绵抵抗剪切/扭曲形变的能力，值越低手感越柔顺。经典记忆棉 μ≈100 Pa。</div>
                </div>

                <div className="pt-2">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400">体积模量 (K = λ + 2μ/3)</span>
                    <span className="font-mono text-rose-400 font-semibold">{params.bulkModulus} Pa</span>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="60000"
                    step="100"
                    value={params.bulkModulus}
                    onChange={(e) => {
                      const K = parseFloat(e.target.value);
                      setParams({ ...params, bulkModulus: K, lambda: K - (2 * params.shearModulus) / 3 });
                      setActivePreset('Custom');
                    }}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">控制材料对体积坍塌与挤压的抵抗。λ≈{Math.round(params.bulkModulus - 2 * params.shearModulus / 3)} Pa。</div>
                </div>

                {/* Density / Young / Poisson readout */}
                <div className="grid grid-cols-3 gap-2 pt-1 text-[10px]">
                  <div className="bg-slate-900/60 rounded border border-slate-800/70 px-2 py-1.5">
                    <div className="text-slate-500">密度 Density</div>
                    <div className="font-mono text-emerald-400">{params.density}D</div>
                  </div>
                  <div className="bg-slate-900/60 rounded border border-slate-800/70 px-2 py-1.5">
                    <div className="text-slate-500">杨氏 E</div>
                    <div className="font-mono text-emerald-400">{Math.round(9 * params.bulkModulus * params.shearModulus / (3 * params.bulkModulus + params.shearModulus))} Pa</div>
                  </div>
                  <div className="bg-slate-900/60 rounded border border-slate-800/70 px-2 py-1.5">
                    <div className="text-slate-500">泊松比 ν</div>
                    <div className="font-mono text-emerald-400">{((3 * params.bulkModulus - 2 * params.shearModulus) / (2 * (3 * params.bulkModulus + params.shearModulus))).toFixed(2)}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Viscoelastic Prony Series Parameter Blocks */}
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-300 flex items-center justify-between">
                <span>2. Prony series 黏弹性慢回弹记忆项</span>
                <span className="text-[10px] text-rose-400 font-mono">Prony Series (3-Terms)</span>
              </h3>
              
              <div className="space-y-4 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg">
                {/* Term 1 Fast Relaxation */}
                <div className="border-b border-slate-800/60 pb-3">
                  <div className="flex justify-between text-xs mb-1 font-semibold text-slate-300">
                    <span>Maxwell 第一项 (Fast) — 局部瞬时松弛</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>松弛强度 (g₁)</span>
                        <span className="font-mono text-rose-400">{params.g1}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="0.5"
                        step="0.01"
                        value={params.g1}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          // Ensure sum doesn't exceed 0.9 to leave g_inf > 0.1
                          const maxG1 = 0.9 - params.g2;
                          const actualG1 = Math.min(val, maxG1);
                          setParams({ ...params, g1: Number(actualG1.toFixed(2)) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>松弛时间 (τ₁ / sec)</span>
                        <span className="font-mono text-rose-400">{params.tau1}s</span>
                      </div>
                      <input
                        type="range"
                        min="0.05"
                        max="1.5"
                        step="0.05"
                        value={params.tau1}
                        onChange={(e) => {
                          setParams({ ...params, tau1: parseFloat(e.target.value) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1.5">负责受力初始阶段的快速应力泄压，使枕头瞬时软化贴合。</div>
                </div>

                {/* Term 2 Medium Relaxation */}
                <div className="border-b border-slate-800/60 pb-3">
                  <div className="flex justify-between text-xs mb-1 font-semibold text-slate-300">
                    <span>Maxwell 第二项 (Medium) — 中期松弛</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>松弛强度 (g₂)</span>
                        <span className="font-mono text-rose-400">{params.g2}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="0.5"
                        step="0.01"
                        value={params.g2}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          const maxG2 = 0.95 - params.g1 - params.g3;
                          const actualG2 = Math.min(val, maxG2);
                          setParams({ ...params, g2: Number(actualG2.toFixed(2)) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>中时间 (τ₂ / sec)</span>
                        <span className="font-mono text-rose-400">{params.tau2}s</span>
                      </div>
                      <input
                        type="range"
                        min="1.0"
                        max="15.0"
                        step="0.5"
                        value={params.tau2}
                        onChange={(e) => {
                          setParams({ ...params, tau2: parseFloat(e.target.value) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1.5">承接第一项之后的中期蠕变，负责数秒内的持续贴合下陷。g₂ = 松弛强度占比，τ₂ = 松弛时间(越大越慢)。</div>
                </div>

                {/* Term 3 Slow Relaxation */}
                <div>
                  <div className="flex justify-between text-xs mb-1 font-semibold text-slate-300">
                    <span>Maxwell 第三项 (Slow) — 整体慢回弹印记</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>松弛强度 (g₃)</span>
                        <span className="font-mono text-rose-400">{params.g3}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="0.5"
                        step="0.01"
                        value={params.g3}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          const maxG3 = 0.95 - params.g1 - params.g2;
                          const actualG3 = Math.min(val, maxG3);
                          setParams({ ...params, g3: Number(actualG3.toFixed(2)) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>慢时间 (τ₃ / sec)</span>
                        <span className="font-mono text-rose-400">{params.tau3}s</span>
                      </div>
                      <input
                        type="range"
                        min="5.0"
                        max="40.0"
                        step="1.0"
                        value={params.tau3}
                        onChange={(e) => {
                          setParams({ ...params, tau3: parseFloat(e.target.value) });
                          setActivePreset('Custom');
                        }}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                      />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1.5">
                    控制枕头按压后凹陷的持久度（慢回弹核心），值越高凹陷停留越久。55D 记忆棉 τ₃≈28s。
                  </div>
                </div>

                {/* Equilibrium factor read-only */}
                <div className="bg-slate-900/60 p-2.5 rounded border border-slate-800/80 flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">长期平衡弹性分数 (g∞ = 1 - g₁ - g₂ - g₃)</span>
                  <span className="font-mono text-emerald-400 font-bold">{(1.0 - params.g1 - params.g2 - params.g3).toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Auxiliary Sim Engine Settings */}
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-300 flex items-center justify-between">
                <span>3. Rayleigh 阻尼与接触常数</span>
                <span className="text-[10px] text-slate-500 font-mono">C = αM + βK</span>
              </h3>
              <div className="grid grid-cols-2 gap-3 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg text-[11px]">
                <div>
                  <div className="flex justify-between"><span className="text-slate-400">质量阻尼 α</span><span className="font-mono text-rose-400">{params.rayleighAlpha}</span></div>
                  <input
                    type="range"
                    min="0"
                    max="1.0"
                    step="0.01"
                    value={params.rayleighAlpha}
                    onChange={(e) => { const a = parseFloat(e.target.value); setParams({ ...params, rayleighAlpha: a, airResistance: a }); }}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer mt-1 accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">正比于质量的整体阻尼，抑制大幅晃动/低频振荡，越大越“稳重发沉”。</div>
                </div>
                <div>
                  <div className="flex justify-between"><span className="text-slate-400">刚度阻尼 β</span><span className="font-mono text-rose-400">{params.rayleighBeta}</span></div>
                  <input
                    type="range"
                    min="0"
                    max="0.05"
                    step="0.001"
                    value={params.rayleighBeta}
                    onChange={(e) => { const b = parseFloat(e.target.value); setParams({ ...params, rayleighBeta: b, damping: Number((b * 900).toFixed(2)) }); }}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer mt-1 accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">正比于刚度的阻尼，抑制弹簧高频抖动、消振防爆，越大越“黏滞不回弹”。</div>
                </div>
                <div>
                  <div className="flex justify-between"><span className="text-slate-400">接触刚度</span><span className="font-mono text-rose-400">{params.contactStiffness}</span></div>
                  <input
                    type="range"
                    min="100"
                    max="1500"
                    step="50"
                    value={params.contactStiffness}
                    onChange={(e) => setParams({ ...params, contactStiffness: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer mt-1 accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">压头与枕头的接触硬度，越大压头越难陷入(接触更硬)，越小陷得越深。</div>
                </div>
                <div>
                  <div className="flex justify-between"><span className="text-slate-400">地面刚度</span><span className="font-mono text-rose-400">{params.groundStiffness}</span></div>
                  <input
                    type="range"
                    min="100"
                    max="1500"
                    step="50"
                    value={params.groundStiffness}
                    onChange={(e) => setParams({ ...params, groundStiffness: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer mt-1 accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">枕头底面与床面的支撑硬度，越大底部越不塌陷、支撑越硬。</div>
                </div>
              </div>
            </div>
          </section>

          {/* Model Import STL Section */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4" id="geometry_settings_section">
            <div className="flex items-center space-x-2">
              <Upload className="w-5 h-5 text-rose-400" />
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">模型导入与网格类型 (STL)</h2>
            </div>

            {/* Pillow geometry choice */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1.5">枕头模型 / Pillow Mesh</label>
                <div className="relative">
                  <input
                    type="file"
                    accept=".stl"
                    id="stl-pillow-input"
                    onChange={handlePillowStlUpload}
                    className="hidden"
                  />
                  <label
                    htmlFor="stl-pillow-input"
                    className="flex items-center justify-center px-2.5 py-2 text-xs rounded transition border cursor-pointer bg-rose-950/20 border-rose-500/40 text-rose-300 hover:border-rose-400"
                  >
                    <Upload className="w-3 h-3 mr-1" />
                    {importedPillowName ? '更换枕头 STL...' : '导入枕头 STL...'}
                  </label>
                </div>
                {importedPillowName && (
                  <div className="text-[10px] text-slate-400 mt-1 bg-slate-950/40 px-2 py-1 rounded border border-slate-800 font-mono truncate">
                    已加载: {importedPillowName}
                  </div>
                )}
              </div>

              {/* Rigid head custom loader */}
              <div>
                <label className="text-xs text-slate-400 block mb-1.5">压头刚体 / Human Head Presser</label>
                <div className="relative">
                  <input
                    type="file"
                    accept=".stl"
                    id="stl-presser-input"
                    onChange={handlePresserStlUpload}
                    className="hidden"
                  />
                  <label
                    htmlFor="stl-presser-input"
                    className={`flex items-center justify-center px-3 py-2 text-xs rounded transition border cursor-pointer ${
                      presserShape === 'custom'
                        ? 'bg-rose-950/20 border-rose-500/40 text-rose-300'
                        : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <Upload className="w-3.5 h-3.5 mr-1" />
                    {importedPresserName ? '更换刚体 STL...' : '导入刚体 STL...'}
                  </label>
                </div>
                {importedPresserName && (
                  <div className="text-[10px] text-slate-400 mt-1 bg-slate-950/40 px-2 py-1 rounded border border-slate-800 font-mono truncate">
                    已加载: {importedPresserName}
                  </div>
                )}
                <button
                  onClick={() => { setPresserShape('anatomy'); setImportedPresserName(''); rebuildVisualPresser(); }}
                  className={`mt-2 w-full px-3 py-2 text-xs rounded transition border ${
                    presserShape === 'anatomy'
                      ? 'bg-rose-950/20 border-rose-500/40 text-rose-300'
                      : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  头-颈-肩解剖模型 (Head · Neck · Shoulder)
                </button>
              </div>

              {/* Head–Neck–Shoulder assembly controls */}
              {presserShape === 'anatomy' && (
                <div className="space-y-3 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg">
                  <div className="text-[11px] font-semibold text-slate-300">颈-肩装配 (多关节颈部)</div>
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>颈部弯曲 (Neck Bend)</span><span className="font-mono text-rose-400">{neckBend.toFixed(1)}</span></div>
                    <input type="range" min="-4" max="10" step="0.5" value={neckBend}
                      onChange={(e) => setNeckBend(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>肩部下沉</span><span className="font-mono text-rose-400">{shoulderDrop.toFixed(1)}</span></div>
                      <input type="range" min="2" max="14" step="0.5" value={shoulderDrop}
                        onChange={(e) => setShoulderDrop(parseFloat(e.target.value))}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>肩部距离</span><span className="font-mono text-rose-400">{shoulderDist.toFixed(1)}</span></div>
                      <input type="range" min="4" max="20" step="0.5" value={shoulderDist}
                        onChange={(e) => setShoulderDist(parseFloat(e.target.value))}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                    </div>
                  </div>
                  <div className="text-[10px] text-slate-500">Head 为实际压枕刚体；Neck 多段沿曲线弯曲连接到 Shoulder 基座。用“压头高度/位置”控制头部，压头下压时颈肩随动。</div>
                </div>
              )}

              {/* Head orientation (X = side-sleep, Y = turn) — visuals + collider */}
              {(presserShape === 'anatomy' || presserShape === 'custom') && (
                <div className="space-y-2 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg">
                  <div className="text-[11px] font-semibold text-slate-300">头部角度 (睡姿)</div>
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>Z 角度 (侧睡 Side-sleep)</span><span className="font-mono text-rose-400">{headRotZ}°</span></div>
                    <input type="range" min="-90" max="90" step="5" value={headRotZ}
                      onChange={(e) => setHeadRotZ(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>X 角度</span><span className="font-mono text-rose-400">{headRotX}°</span></div>
                      <input type="range" min="-90" max="90" step="5" value={headRotX}
                        onChange={(e) => setHeadRotX(parseFloat(e.target.value))}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] text-slate-400 mb-1"><span>Y 角度 (转头)</span><span className="font-mono text-rose-400">{headRotY}°</span></div>
                      <input type="range" min="-90" max="90" step="5" value={headRotY}
                        onChange={(e) => setHeadRotY(parseFloat(e.target.value))}
                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                    <button onClick={() => { setHeadRotX(0); setHeadRotY(0); setHeadRotZ(0); }} className={`py-1 rounded border ${headRotX === 0 && headRotY === 0 && headRotZ === 0 ? 'bg-rose-950/20 border-rose-500/40 text-rose-300' : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>仰睡 0°</button>
                    <button onClick={() => setHeadRotZ(90)} className={`py-1 rounded border ${headRotZ === 90 ? 'bg-rose-950/20 border-rose-500/40 text-rose-300' : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>侧睡 Z90°</button>
                    <button onClick={() => setHeadRotZ(-90)} className={`py-1 rounded border ${headRotZ === -90 ? 'bg-rose-950/20 border-rose-500/40 text-rose-300' : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'}`}>侧睡 Z-90°</button>
                  </div>
                  <div className="text-[10px] text-slate-500">绕 Z 轴旋转即侧睡；碰撞体会把头部旋到对应角度再判定压陷。</div>
                </div>
              )}

              {/* Presser weight & horizontal position */}
              <div className="space-y-3 bg-slate-950/40 border border-slate-800/50 p-3.5 rounded-lg">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400">刚体重量 (Mass)</span>
                    <span className="font-mono text-rose-400 font-semibold">{presserMass.toFixed(1)} kg</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="40"
                    step="0.5"
                    value={presserMass}
                    onChange={(e) => setPresserMass(parseFloat(e.target.value))}
                    className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                  />
                  <div className="text-[10px] text-slate-500 mt-1">影响“重力坠落”测试的冲击力与最终凹陷深度。</div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                      <span>位置 X (左右)</span>
                      <span className="font-mono text-rose-400">{presserX.toFixed(1)}</span>
                    </div>
                    <input
                      type="range"
                      min="-12"
                      max="12"
                      step="0.5"
                      value={presserX}
                      onChange={(e) => setPresserX(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-400 mb-1">
                      <span>位置 Y (前后)</span>
                      <span className="font-mono text-rose-400">{presserZ.toFixed(1)}</span>
                    </div>
                    <input
                      type="range"
                      min="-8"
                      max="8"
                      step="0.5"
                      value={presserZ}
                      onChange={(e) => setPresserZ(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                    />
                  </div>
                </div>
              </div>

              {/* Boundary / anchors style selection */}
              <div>
                <label className="text-xs text-slate-400 block mb-1.5">边界支撑点 / Boundary Anchoring</label>
                <div className="grid grid-cols-3 gap-1.5 text-xs">
                  {[
                    { id: 'bottom', name: '底部全固定' },
                    { id: 'corners', name: '四角固定' },
                    { id: 'none', name: '无(自由滑移)' }
                  ].map((style) => (
                    <button
                      key={style.id}
                      onClick={() => {
                        setAnchorStyle(style.id as any);
                        if (simRef.current) simRef.current.updateAnchors(style.id as any);
                      }}
                      className={`py-1.5 rounded transition border ${
                        anchorStyle === style.id
                          ? 'bg-rose-950/20 border-rose-500/40 text-rose-300'
                          : 'bg-slate-950/50 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {style.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

        </div>

        {/* CENTER COLUMN: Interactive 3D Canvas viewport & Quick Actions (Width 5/12) */}
        <div className="xl:col-span-5 flex flex-col space-y-5" id="center_col">
          
          {/* Main 3D Canvas Box */}
          <div className={`bg-slate-900 border border-slate-800 overflow-hidden relative shadow-lg flex flex-col ${
            isViewportMax
              ? 'fixed inset-0 z-[100] rounded-none min-h-screen'
              : 'rounded-xl flex-1 min-h-[720px]'
          }`} id="viewport_container">
            
            {/* Overlay View controls */}
            <div className="absolute top-16 left-4 z-10 flex space-x-2 bg-slate-950/80 p-1.5 rounded-lg border border-slate-800/80 backdrop-blur" id="view_overlay_controls">
              <button 
                onClick={() => setColorMode('strain')}
                className={`px-2.5 py-1 text-[10px] font-semibold rounded transition ${
                  colorMode === 'strain' ? 'bg-rose-500 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                应变云图 (Strain Map)
              </button>
              <button 
                onClick={() => setColorMode('rebound')}
                className={`px-2.5 py-1 text-[10px] font-semibold rounded transition ${
                  colorMode === 'rebound' ? 'bg-rose-500 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                回弹速率 (Recovery)
              </button>
              <button 
                onClick={() => setColorMode('material')}
                className={`px-2.5 py-1 text-[10px] font-semibold rounded transition ${
                  colorMode === 'material' ? 'bg-rose-500 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                真实材质 (Fabric)
              </button>
            </div>

            {/* Wireframe visibility overlay toggles */}
            <div className="absolute top-16 right-4 z-10 flex space-x-2 bg-slate-950/80 p-1 rounded-lg border border-slate-800/80 backdrop-blur text-[10px]" id="render_toggles">
              <label className="flex items-center px-2 py-1 space-x-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showWireframe}
                  onChange={(e) => toggleWireframe(e.target.checked)}
                  className="rounded text-rose-500 focus:ring-rose-500/20 bg-slate-900 border-slate-800 w-3 h-3"
                />
                <span className="text-slate-300">结构网格</span>
              </label>
              <label className="flex items-center px-2 py-1 space-x-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showParticles}
                  onChange={(e) => toggleParticles(e.target.checked)}
                  className="rounded text-rose-500 focus:ring-rose-500/20 bg-slate-900 border-slate-800 w-3 h-3"
                />
                <span className="text-slate-300">微观质点</span>
              </label>
              <button
                onClick={() => setIsViewportMax(v => !v)}
                title={isViewportMax ? '还原窗口' : '最大化窗口'}
                className="flex items-center px-2 py-1 rounded hover:bg-slate-800 text-slate-300 transition"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Timeline control console bar (moved above the canvas) */}
            <div className="bg-slate-900 border-b border-slate-800/80 px-4 py-3 flex items-center justify-between" id="timeline_controls">
              
              {/* Play Pause Controls */}
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setIsPaused(!isPaused)}
                  className={`p-2 rounded-lg border transition ${
                    isPaused 
                      ? 'bg-rose-600 border-rose-500 text-white hover:bg-rose-500' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                  title={isPaused ? '继续模拟' : '暂停模拟'}
                >
                  {isPaused ? <Play className="w-4 h-4 fill-white" /> : <Pause className="w-4 h-4" />}
                </button>
                <button
                  onClick={resetSimulation}
                  className="p-2 bg-slate-800 border border-slate-700 text-slate-300 rounded-lg hover:bg-slate-700 transition"
                  title="重置模拟"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </div>

              {/* Head height presser controller slider */}
              <div className="flex-1 max-w-xs mx-6 flex items-center space-x-3">
                <span className="text-xs text-slate-400 font-medium whitespace-nowrap">压头高度:</span>
                <input
                  type="range"
                  min="3.0"
                  max="16.0"
                  step="0.1"
                  disabled={autoCycleActive}
                  value={presserHeight}
                  onChange={(e) => {
                    const h = parseFloat(e.target.value);
                    setPresserHeight(h);
                    if (simRef.current) {
                      simRef.current.presser.isControlled = true;
                      simRef.current.presser.autoCycleActive = false;
                      setAutoCycleActive(false);
                    }
                  }}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500 disabled:opacity-40"
                />
                <span className="text-xs font-mono text-rose-400 whitespace-nowrap">{presserHeight.toFixed(1)} cm</span>
              </div>

              {/* Mode actions triggers */}
              <div className="flex space-x-2">
                <button
                  onClick={triggerDropTest}
                  className="px-3 py-1.5 bg-rose-950/40 border border-rose-800/30 hover:border-rose-700 text-rose-400 text-xs font-semibold rounded-lg hover:bg-rose-900/20 transition flex items-center space-x-1"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>重力坠落</span>
                </button>
                <button
                  onClick={toggleCyclicTest}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition border flex items-center space-x-1 ${
                    autoCycleActive
                      ? 'bg-sky-950/40 border-sky-500 text-sky-400 animate-pulse'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  <span>周期挤压</span>
                </button>
              </div>

            </div>

            {/* ThreeJS Container DOM */}
            <div ref={containerRef} className="w-full flex-1 relative bg-slate-950" id="threejs_canvas_parent"></div>
          </div>

          {/* Quick Info details */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 flex items-start space-x-3 shadow-md" id="info_card">
            <Info className="w-5 h-5 text-sky-400 flex-shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              <h4 className="font-bold text-slate-300 mb-1">交互说明:</h4>
              <p>你可以直接用鼠标在3D窗口中**拖拽或缩放**，从各个角度观测记忆棉内部的剪切形变及慢回弹凹陷保留效果。滑动上方“压头高度”拉条，可模拟人头枕下。点击“重力坠落”触发落球测试，“周期挤压”能够自动往复升降并绘制完整的**力学迟滞环 (Hysteresis Loop)**。</p>
            </div>
          </section>

        </div>

        {/* RIGHT COLUMN: Interactive Charts & Diagnostic Indicators (Width 3/12) */}
        <div className="xl:col-span-3 flex flex-col space-y-5" id="right_col">
          
          {/* Scientific plots panel */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg flex-1 flex flex-col min-h-[300px]" id="charts_section">
            <div className="flex items-center space-x-2 mb-4 border-b border-slate-800 pb-3">
              <Activity className="w-5 h-5 text-rose-400" />
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">材料应力松弛与迟滞特性</h2>
            </div>

            {/* Plot 1: Hysteresis loop Force vs Displacement */}
            <div className="flex-1 flex flex-col min-h-[160px] mb-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[11px] font-semibold text-slate-300">迟滞回线 (Hysteresis Loop: 力 - 位移)</span>
                <span className="text-[9px] text-rose-400 font-mono">Force vs. Indentation</span>
              </div>
              <div className="flex-1 bg-slate-950/80 rounded-lg p-2 border border-slate-850">
                <ChartErrorBoundary>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="displacement" stroke="#475569" fontSize={9} />
                      <YAxis stroke="#475569" fontSize={9} />
                      <Tooltip contentStyle={{ background: '#0f172a', borderColor: '#334155', fontSize: 10 }} />
                      <Line type="monotone" dataKey="force" name="抗力" stroke="#f43f5e" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartErrorBoundary>
              </div>
              <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">由于 Prony 慢回弹，压缩与卸载路径不重合。迟滞环面积越大，表明材料耗散振动与冲击的能量吸收能力越强。</p>
            </div>

            {/* Plot 2: Force Relaxation vs Time */}
            <div className="flex-1 flex flex-col min-h-[160px]">
              <div className="flex justify-between items-center mb-2">
                <span className="text-[11px] font-semibold text-slate-300">应力松弛 (Relaxation Curve: 力 - 时间)</span>
                <span className="text-[9px] text-rose-400 font-mono">Force vs. Time</span>
              </div>
              <div className="flex-1 bg-slate-950/80 rounded-lg p-2 border border-slate-850">
                <ChartErrorBoundary>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="time" stroke="#475569" fontSize={9} />
                      <YAxis stroke="#475569" fontSize={9} />
                      <Tooltip contentStyle={{ background: '#0f172a', borderColor: '#334155', fontSize: 10 }} />
                      <Line type="monotone" dataKey="force" name="松弛应力" stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartErrorBoundary>
              </div>
              <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">在恒定按压位移下，可见反弹力随时间呈多级指数衰减（应力松弛现象），最终趋于平衡刚度值。</p>
            </div>
          </section>

          {/* Diagnostic Metrics */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4" id="diagnostic_metrics_panel">
            <div className="flex items-center space-x-2 border-b border-slate-800 pb-3">
              <Activity className="w-5 h-5 text-rose-400" />
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">物理诊断参数 / Telemetry</h2>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[10px]">当前反弹抗力</div>
                <div className="text-lg font-bold text-rose-400 mt-1">{stats.totalForce} N</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[10px]">系统动能 (Kinetic)</div>
                <div className="text-lg font-bold text-sky-400 mt-1">{stats.kineticEnergy} J</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[10px]">质点数 (Lattice)</div>
                <div className="text-slate-300 font-bold mt-1">{stats.particlesCount} 点</div>
              </div>
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
                <div className="text-slate-500 text-[10px]">应变能阻尼率</div>
                <div className="text-emerald-400 font-bold mt-1">{stats.relaxationRate} s⁻¹</div>
              </div>
            </div>

            {/* Export and download deformed STL button */}
            <div className="pt-2">
              <button
                onClick={handleStlExport}
                className="w-full py-2.5 bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white font-semibold text-xs rounded-lg transition-all shadow-md flex items-center justify-center space-x-2 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>导出形变后枕头网格 (.STL)</span>
              </button>
              <p className="text-[10px] text-slate-500 text-center mt-1.5">你可以直接导出当前变形或塌陷状态下的高保真枕头三维网格模型，用于 CAD 设计、有限元比对或 3D 打印。</p>
            </div>
          </section>

        </div>

      </main>

      {/* Professional Footer status info */}
      <footer className="border-t border-slate-900 bg-slate-950/80 py-3 text-center text-xs text-slate-500 mt-auto" id="footer">
        Memory Foam Viscoelastic Pillow Simulation System • Multi-term Prony Relax Engine © 2026
      </footer>

    </div>
  );
}
