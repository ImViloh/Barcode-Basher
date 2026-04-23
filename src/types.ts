export type StrategyId =
  | 'rle_forensics'
  | 'forensics_png_text'
  | 'zxing_native'
  | 'zxing_otsu_png'
  | 'zxing_sharpen'
  | 'zxing_normalize'
  | 'zxing_flip_h'
  | 'zxing_flip_v'
  | 'zxing_rot180'
  | 'zxing_rot90'
  | 'zxing_rot270'
  | 'zxing_geom_flop_rot90'
  | 'zxing_geom_flop_rot270'
  | 'zxing_geom_flip_rot90'
  | 'zxing_geom_flip_rot270'
  | 'zxing_geom_rot90_flop'
  | 'zxing_geom_rot90_flip'
  | 'zxing_geom_rot180_flop'
  | 'zxing_geom_flop_rot180'
  | 'zxing_geom_rot270_flop'
  | 'zxing_geom_rot270_flip'
  | 'zxing_greyscale'
  | 'zxing_modulate_bright'
  | 'zxing_modulate_dark'
  | 'zxing_linear_contrast'
  | 'zxing_blur_mild'
  | 'zxing_vertical_bands'
  | 'zxing_pure_barcode'
  | 'zxing_assume_gs1'
  | 'zxing_formats_1d_only'
  | 'zxing_invert'
  | 'zxing_pad_quiet'
  | 'zxing_local_adaptive'
  | 'bc4_block_quant_luma'
  | 'bc7ish_block_quant_rgb'
  | 'zxing_stretch_2x'
  | 'zxing_threshold_sweep'
  | 'zxing_exhaustive_chains'
  | 'zxing_threshold_sweep_crib'
  | 'zxing_crib_gate_bundle'
  | 'engine_jsbarcode_multi'
  | 'engine_jsbarcode_detect_rot'
  | 'engine_jsqr';

export interface StrategyJob {
  jobId: StrategyId;
  /** Filled by orchestrator before spawning a worker */
  imagePath?: string;
  /** e.g. `{ crib: 'YOUR CHARM' }` for crib-aware workers */
  extra?: Record<string, unknown>;
}

export interface StrategyWorkerSuccess {
  ok: true;
  jobId: StrategyId;
  label: string;
  text: string;
  format?: string;
  ms: number;
  notes: string[];
}

export interface StrategyWorkerFailure {
  ok: false;
  jobId: StrategyId;
  label: string;
  ms: number;
  error: string;
  notes: string[];
}

export type StrategyWorkerResult = StrategyWorkerSuccess | StrategyWorkerFailure;

export interface FileChecksums {
  fileSize: number;
  fileMd5: string;
  fileSha256: string;
  rawPixelBytes: number;
  rawPixelMd5: string;
  rawPixelSha256: string;
}

export interface ImageForensics {
  path: string;
  width: number;
  height: number;
  channels: number;
  meanLuma: number;
  minLuma: number;
  maxLuma: number;
  otsuThreshold: number;
  /** Normalized scanline 0..1 */
  projectionSample: number[];
  /** First ~64 module run lengths after normalization */
  moduleRunPreview: number[];
  quietZoneEstimatePx: { left: number; right: number };
  checksums: FileChecksums;
  /** Hex dump (first bytes of center raster row, raw interleaved channels). */
  hexCenterRowRgba: string;
  /** Otsu-thresholded middle scanline as 0/1 (truncated). */
  binaryScanlineOtsu: string;
  /** Shannon entropy (bits/symbol) on full luma plane. */
  entropyLumaGlobal: number;
  /** Shannon entropy on center-row raw bytes. */
  entropyCenterRowRgba: number;
}
