/**
 * 补纸配色工具
 * - ΔE 色差计算（CIE76，sRGB → XYZ → Lab）
 * - 帘纹匹配度评估
 * - 染色配方浓度换算
 */
import { DEFAULT_DYE_RECIPE, DELTA_E_THRESHOLD, type PaperType } from '@/types/paper'

/** 各纸种的基准色（sRGB 十六进制），用于色差比对 */
export const PAPER_BASE_COLOR: Record<PaperType, string> = {
  bamboo: '#d9c9a3',
  bark: '#e3d6bd',
  xuan: '#f2ece0'
}

/** 纸质原叶的色调基准（按破损类型给出典型色） */
export const DAMAGE_TONE_COLOR = {
  worm: '#c9b58c',
  acid: '#c8a97a',
  fibrin: '#ded2b8',
  loss: '#bfa87f',
  stain: '#b9a98d'
} as const

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const num = Number.parseInt(full, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** sRGB → CIE Lab（D65 光源） */
export function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as [number, number, number]
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 色差 ΔE */
export function deltaE76(hexA: string, hexB: string): number {
  const [l1, a1, b1] = hexToLab(hexA)
  const [l2, a2, b2] = hexToLab(hexB)
  return Math.round(Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) * 100) / 100
}

/** 原叶色调 → 目标补纸色，返回色差 ΔE */
export function deltaEForLeaf(damageType: keyof typeof DAMAGE_TONE_COLOR, paperType: PaperType): number {
  return deltaE76(DAMAGE_TONE_COLOR[damageType], PAPER_BASE_COLOR[paperType])
}

/** 帘纹匹配度（0-100）：名称一致为 100，同族相近似 70，无帘纹最低 40 */
export function laidPatternMatch(paperPattern: string, leafPattern: string): number {
  if (paperPattern === leafPattern) return 100
  const sameFamily = paperPattern.slice(0, 2) === leafPattern.slice(0, 2)
  if (sameFamily) return 70
  if (paperPattern === '无帘纹' || leafPattern === '无帘纹') return 40
  return 55
}

/** 综合候选评分：色差越小、帘纹越匹配、厚度越接近得分越高 */
export function candidateScore(paper: {
  deltaE: number
  laidPattern: string
  thicknessMm: number
}, leafPattern: string, leafThicknessMm = 0.06): number {
  const colorScore = Math.max(0, 100 - paper.deltaE * 12)
  const patternScore = laidPatternMatch(paper.laidPattern, leafPattern)
  const thicknessScore = Math.max(0, 100 - Math.abs(paper.thicknessMm - leafThicknessMm) * 800)
  return Math.round(colorScore * 0.5 + patternScore * 0.3 + thicknessScore * 0.2)
}

/** 是否需要重新染色 */
export function needRedye(deltaE: number): boolean {
  return deltaE > DELTA_E_THRESHOLD
}

/** 染色配方浓度换算：按目标 ΔE 与纸量给出染料倍率 */
export function recipeConcentration(
  paperType: PaperType,
  deltaE: number,
  paperCount = 1
): { recipe: string; multiplier: number; note: string } {
  const multiplier = Math.max(0.4, Math.round((1 + deltaE / 5) * 10) / 10)
  const recipe = DEFAULT_DYE_RECIPE[paperType]
  const note =
    deltaE > DELTA_E_THRESHOLD
      ? `色差 ${deltaE} 超出阈值 ${DELTA_E_THRESHOLD}，按 ${multiplier} 倍浓度补染，并对 ${paperCount} 张补纸同浴处理`
      : `色差 ${deltaE} 在阈值内，按 ${multiplier} 倍浓度微调即可`
  return { recipe, multiplier, note }
}
