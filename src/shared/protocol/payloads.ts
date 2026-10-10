/**
 * Tool payload shapes carried inside CadEventEnvelope.payload.
 */

export interface BuildPayload {
  step?: string;
  sidecars?: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface VisualPayload {
  views?: Array<{
    name: string;
    path: string;
    camera: Record<string, number[]>;
    width: number;
    height: number;
  }>;
  units?: string;
  bbox?: number[];
  occurrenceCount?: number;
  solidCount?: number;
  error?: string;
}

export interface GeometryPayload {
  units?: string;
  bbox?: { x: number; y: number; z: number };
  volume?: number;
  surfaceArea?: number;
  solidCount?: number;
  validity?: {
    ok: boolean;
    failureCount: number;
    reasons: string[];
    checks: { topology: boolean; closedShells: boolean; positiveVolume: boolean };
    solids: Array<{
      solidIndex: number;
      topologyValid: boolean;
      closedShells: boolean;
      signedVolume: number;
      positiveVolume: boolean;
      reasons: string[];
    }>;
  };
  occurrenceCount?: number;
  faceCount?: number;
  /** One record per face (capped at 5,000), used to find changes between builds. */
  faceFingerprints?: FaceFingerprint[];
  faceFingerprintsTruncated?: boolean;
  cylinders?: Array<Record<string, unknown>>;
  planes?: Array<Record<string, unknown>>;
  error?: string;
}

export interface FaceFingerprint {
  i?: number;
  type: string;
  /** Centroid, mm. */
  c: [number, number, number];
  /** Area, mm^2. */
  a: number;
  /** Plane normal. */
  n?: number[];
  /** Cylinder or cone axis direction. */
  ax?: number[];
  /** A point on the cylinder or cone axis. */
  ap?: number[];
  /** Cylinder or cone radius. */
  r?: number;
}
