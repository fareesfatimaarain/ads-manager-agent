/**
 * Creative generation contracts.
 *
 * Copy and imagery come from different providers with different failure modes, so they sit
 * behind separate interfaces. Both are pluggable: the decision engine and the launch pipeline
 * know nothing about which model wrote the words or which service drew the picture.
 */

export interface BrandKit {
  readonly id: string;
  readonly clientId: string;
  readonly version: number;
  readonly palette: { readonly name: string; readonly hex: string }[];
  readonly fonts: { readonly display: string; readonly body: string };
  readonly tone: string;
  /** Words that must never appear. Enforced during generation, then re-checked after. */
  readonly bannedWords: readonly string[];
  /** Claims that must never be made — regulatory, legal, or brand-policy. */
  readonly bannedClaims: readonly string[];
  readonly requiredDisclaimers: readonly string[];
  readonly logoAssetId: string | null;
}

export interface CreativeBrief {
  readonly clientName: string;
  /** Who the ad is for. */
  readonly icp: string;
  /** What is being sold and why it is worth buying. */
  readonly offer: string;
  readonly landingPageUrl: string;
  readonly objective: 'CPA' | 'ROAS';
  /** Angles already tested, with how they did. This is what makes the system learn. */
  readonly anglePerformance: readonly AnglePerformance[];
  /** Angles to avoid repeating, e.g. because they are already live. */
  readonly excludeAngles: readonly string[];
  readonly variantCount: number;
}

export interface AnglePerformance {
  readonly angleTag: string;
  readonly variantsTested: number;
  readonly totalSpendCents: number;
  readonly totalConversions: number;
  readonly cpaCents: number | null;
  readonly verdict: 'WINNER' | 'MIXED' | 'LOSER' | 'UNTESTED';
}

export interface GeneratedCopy {
  readonly angleTag: string;
  readonly hookType: string;
  readonly headline: string;
  readonly primaryText: string;
  readonly cta: string;
  /** Why this angle, in the generator's own words. Feeds the next round. */
  readonly reasoning: string;
  /** What the visual should show, handed to the image provider. */
  readonly imageConcept: string;
}

export interface CopyGenerator {
  readonly name: string;
  generate(brief: CreativeBrief, brandKit: BrandKit): Promise<GeneratedCopy[]>;
}

export interface ImageRequest {
  readonly concept: string;
  readonly palette: readonly string[];
  readonly aspectRatio: '1:1' | '4:5' | '16:9';
  /** Stable key so a retry does not pay for a second image. */
  readonly idempotencyKey: string;
}

export interface GeneratedImage {
  readonly provider: string;
  readonly providerAssetId: string;
  readonly url: string;
  readonly prompt: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface CreativeProvider {
  readonly name: string;
  generateImage(request: ImageRequest): Promise<GeneratedImage>;
}

export class CreativeGenerationError extends Error {
  constructor(
    message: string,
    readonly stage: 'COPY' | 'IMAGE' | 'BRAND_CHECK',
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CreativeGenerationError';
  }
}
