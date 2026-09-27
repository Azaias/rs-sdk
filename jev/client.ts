// Minimal typed client for Jev (TypeSafe's System One model) through OpenRouter.
//
// OpenRouter exposes TypeSafe's request/response shape at POST /api/v1/systemone
// and bills it to your OpenRouter key. Jev never generates text: you send a
// `state` and typed questions (choice / noul / score) and get back typed answers
// with probabilities. See https://openrouter.ai/docs/guides/community/jev
//
// Env (bun auto-loads the project-root .env):
//   OPENROUTER_API_KEY  required
//   JEV_MODEL           default "jev-1.13" (pinned; use "jev-latest" to track releases)
//   JEV_BASE_URL        default "https://openrouter.ai/api"

/** Instructions and criteria accept plain strings or JSON structure. */
export type Desc = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
    type: 'noul';
    instructions: Desc;
    criteria?: { true?: Desc; false?: Desc };
}

export interface ChoiceQuestion<K extends string = string> {
    type: 'choice';
    instructions: Desc;
    /** Option -> description (null when the option name says it all). Max 255 options. */
    criteria: Record<K, Desc | null>;
}

export interface ScoreQuestion {
    type: 'score';
    instructions: Desc;
    /** Ordered level descriptions, 2..10 of them. */
    criteria: Desc[];
}

export type Question = NoulQuestion | ChoiceQuestion<string> | ScoreQuestion;

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer<K extends string = string> {
    type: 'choice';
    choice: K;
    probabilities: Record<K, number>;
    confidence: number;
}
export interface ScoreAnswer {
    type: 'score';
    score: number;
    legend: Record<string, string>;
    probabilities: Record<string, number>;
    confidence: number;
}

export type AnswerFor<Q> =
    Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K> :
    Q extends NoulQuestion ? NoulAnswer :
    Q extends ScoreQuestion ? ScoreAnswer : never;

export interface SystemOneResult<Qs extends Record<string, Question>> {
    id?: string;
    model: string;
    answers: { [K in keyof Qs]: AnswerFor<Qs[K]> };
    usage: { input_tokens: number; output_tokens: number; cost?: number };
}

export class JevError extends Error {
    constructor(message: string, readonly status?: number, readonly body?: string) {
        super(message);
        this.name = 'JevError';
    }
}

export interface JevClientOptions {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    /** Per-attempt timeout (default 20s). */
    timeoutMs?: number;
    /** Attempts for 429 / 529 / 5xx / network errors (default 4). */
    maxAttempts?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export class JevClient {
    readonly model: string;
    private readonly apiKey: string;
    private readonly url: string;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;

    /** Running totals across every call this client made. */
    calls = 0;
    inputTokens = 0;
    costUsd = 0;

    constructor(opts: JevClientOptions = {}) {
        const apiKey = (opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '').trim();
        if (!apiKey) throw new JevError('OPENROUTER_API_KEY is not set (put it in the project-root .env)');
        this.apiKey = apiKey;
        this.model = opts.model ?? process.env.JEV_MODEL ?? 'jev-1.13';
        const base = (opts.baseURL ?? process.env.JEV_BASE_URL ?? 'https://openrouter.ai/api').replace(/\/+$/, '');
        this.url = `${base}/v1/systemone`;
        this.timeoutMs = opts.timeoutMs ?? 20_000;
        this.maxAttempts = opts.maxAttempts ?? 4;
    }

    /** Evaluate one state against several independent questions in a single request. */
    async ask<Qs extends Record<string, Question>>(state: unknown, questions: Qs): Promise<SystemOneResult<Qs>> {
        const body = JSON.stringify({ model: this.model, state, questions });
        let lastError: unknown;

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            let res: Response;
            try {
                res = await fetch(this.url, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (err) {
                lastError = err;
                await backoff(attempt);
                continue;
            }

            if (res.ok) {
                const result = await res.json() as SystemOneResult<Qs>;
                this.calls++;
                this.inputTokens += result.usage?.input_tokens ?? 0;
                this.costUsd += result.usage?.cost ?? 0;
                return result;
            }

            const text = await res.text();
            if (!RETRYABLE.has(res.status) || attempt === this.maxAttempts) {
                throw new JevError(`Jev request failed: HTTP ${res.status} ${text.slice(0, 500)}`, res.status, text);
            }
            lastError = new JevError(`HTTP ${res.status}`, res.status, text);
            const retryAfter = Number(res.headers.get('retry-after'));
            await backoff(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
        }
        throw lastError instanceof Error ? lastError : new JevError(String(lastError));
    }
}

function backoff(attempt: number, overrideMs?: number): Promise<void> {
    const ms = overrideMs ?? Math.min(8_000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
    return new Promise(r => setTimeout(r, ms));
}

// ---- Question helpers -------------------------------------------------------

export const noul = (instructions: Desc, criteria?: NoulQuestion['criteria']): NoulQuestion =>
    ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });

export const choice = <K extends string>(instructions: Desc, criteria: Record<K, Desc | null>): ChoiceQuestion<K> =>
    ({ type: 'choice', instructions, criteria });

export const score = (instructions: Desc, criteria: Desc[]): ScoreQuestion =>
    ({ type: 'score', instructions, criteria });

/** Top-n options of a choice answer, highest probability first. */
export function topChoices<K extends string>(a: ChoiceAnswer<K>, n = 3): Array<[K, number]> {
    return (Object.entries(a.probabilities) as Array<[K, number]>).sort((x, y) => y[1] - x[1]).slice(0, n);
}
