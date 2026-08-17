/**
 * Image providers behind one interface.
 *
 * The mock is not a stub — it is the provider every test and offline run uses, and it is
 * deterministic so a regenerated variant produces the same asset id. Swapping in a real
 * provider changes nothing above this file.
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { CreativeGenerationError, type CreativeProvider, type GeneratedImage, type ImageRequest } from './types.js';

const ASPECT_DIMENSIONS: Record<ImageRequest['aspectRatio'], { w: number; h: number }> = {
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '16:9': { w: 1920, h: 1080 },
};

/** Deterministic placeholder provider. No network, no cost, stable ids. */
export class MockImageProvider implements CreativeProvider {
  readonly name = 'mock';

  // eslint-disable-next-line @typescript-eslint/require-await
  async generateImage(request: ImageRequest): Promise<GeneratedImage> {
    const digest = createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 16);
    const { w, h } = ASPECT_DIMENSIONS[request.aspectRatio];
    return {
      provider: this.name,
      providerAssetId: `mock_img_${digest}`,
      url: `https://placehold.co/${w}x${h}?text=${encodeURIComponent(request.concept.slice(0, 40))}`,
      prompt: request.concept,
      widthPx: w,
      heightPx: h,
    };
  }
}

/**
 * Ideogram. Chosen because ad creative frequently needs legible text inside the image, which
 * is where most image models fall down.
 */
export class IdeogramProvider implements CreativeProvider {
  readonly name = 'ideogram';
  private static readonly ENDPOINT = 'https://api.ideogram.ai/generate';

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('IdeogramProvider requires an API key');
  }

  async generateImage(request: ImageRequest): Promise<GeneratedImage> {
    const { w, h } = ASPECT_DIMENSIONS[request.aspectRatio];
    const prompt = `${request.concept}. Brand palette: ${request.palette.join(', ')}. Advertising photography, no text overlay.`;

    let response: Response;
    try {
      response = await fetch(IdeogramProvider.ENDPOINT, {
        method: 'POST',
        headers: { 'Api-Key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          image_request: {
            prompt,
            aspect_ratio: request.aspectRatio === '1:1' ? 'ASPECT_1_1' : request.aspectRatio === '4:5' ? 'ASPECT_4_5' : 'ASPECT_16_9',
            model: 'V_2',
            magic_prompt_option: 'AUTO',
          },
        }),
      });
    } catch (error) {
      throw new CreativeGenerationError('image provider unreachable', 'IMAGE', true, error);
    }

    if (!response.ok) {
      // 4xx means the request is wrong and retrying it unchanged cannot help.
      const retryable = response.status === 429 || response.status >= 500;
      throw new CreativeGenerationError(
        `image provider returned ${response.status} ${response.statusText}`,
        'IMAGE',
        retryable,
      );
    }

    const body = (await response.json()) as { data?: { url?: string }[] };
    const url = body.data?.[0]?.url;
    if (!url) {
      throw new CreativeGenerationError('image provider returned no image URL', 'IMAGE', true);
    }

    return {
      provider: this.name,
      providerAssetId: createHash('sha256').update(url).digest('hex').slice(0, 16),
      url,
      prompt,
      widthPx: w,
      heightPx: h,
    };
  }
}

/** Video is declared but not implemented; the interface exists so the shape is settled. */
export class UnimplementedVideoProvider implements CreativeProvider {
  readonly name = 'video-unimplemented';
  // eslint-disable-next-line @typescript-eslint/require-await
  async generateImage(): Promise<GeneratedImage> {
    throw new CreativeGenerationError(
      'video generation is not implemented; enable an image provider instead',
      'IMAGE',
      false,
    );
  }
}

export function resolveImageProvider(): CreativeProvider {
  if (env.imageProvider === 'ideogram') {
    if (!env.ideogramApiKey) {
      throw new Error('IMAGE_PROVIDER=ideogram but IDEOGRAM_API_KEY is not set');
    }
    return new IdeogramProvider(env.ideogramApiKey);
  }
  return new MockImageProvider();
}
