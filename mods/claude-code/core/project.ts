// Which expert profiles a project calls for, read from the project itself: its
// folder's name, the kinds of files it holds and the libraries it uses. Pure and
// local: it runs once on the vocabulary the host already collects.

import type { Rigor } from './bundle'
import type { Vocabulary } from './grounding'

/** A profile the project calls for, how much is at stake there, and why it was chosen (shown by /margincue status). */
export type ProjectLens = { profile: string; rigor: Rigor; score: number; reasons: string[] }

/** Score at which a profile applies to every prompt in the project. */
export const LENS_THRESHOLD = 4

const ML_NAME_LONG = ['research', 'challenge', 'hackathon', 'dataset', 'benchmark', 'experiment', 'kaggle', 'learning',
  'thesis', 'neural', 'predict', 'forecast', 'classif', 'regression', 'toxicity', 'crowding']
const ML_NAME_SHORT = new Set(['ml', 'ai', 'mlp', 'cnn', 'rnn', 'nlp', 'llm', 'data', 'lab', 'stats', 'paper', 'study',
  'model', 'models', 'quant', 'cv', 'rl'])
const COMPETE = ['challenge', 'hackathon', 'kaggle', 'competition', 'leaderboard', 'contest']
const STUDY = ['research', 'thesis', 'paper', 'study', 'lab', 'phd', 'experiment']

const ML_LIBS = new Set(['torch', 'tensorflow', 'keras', 'jax', 'flax', 'sklearn', 'scikit-learn', 'xgboost', 'lightgbm',
  'catboost', 'statsmodels', 'transformers', 'datasets', 'optuna', 'pytorch_lightning', 'lightning', 'mlflow', 'wandb',
  'tfjs', 'onnxruntime', 'pymc', 'sktime', 'prophet', 'timm', 'accelerate', 'peft'])
const DATA_LIBS = new Set(['pandas', 'numpy', 'scipy', 'polars', 'matplotlib', 'seaborn', 'plotly', 'pyarrow'])
const SYSTEM_LIBS = new Set(['kafka', 'kafkajs', 'redis', 'ioredis', 'celery', 'pika', 'amqplib', 'grpc', 'grpcio',
  'bullmq', 'sqlalchemy', 'prisma', 'typeorm', 'nats', 'boto3', 'elasticsearch', 'mongoose', 'pymongo', 'psycopg2',
  'pg', 'fastapi', 'express', 'nestjs', 'django', 'flask', 'gunicorn', 'uvicorn', 'temporalio', 'aiokafka', 'confluent_kafka'])
const SYSTEM_NAME = new Set(['api', 'service', 'services', 'backend', 'server', 'platform', 'infra', 'gateway', 'microservice', 'microservices'])

const count = (files: string[], test: RegExp) => files.filter((path) => test.test(path)).length

export function detectLenses(vocab: Vocabulary, prefer: readonly string[] = []): ProjectLens[] {
  // A field the person works in needs half the evidence: their data folder is a research project.
  const threshold = (profile: string) => prefer.includes(profile) ? LENS_THRESHOLD / 2 : LENS_THRESHOLD
  const files = vocab.files
  const name = (vocab.project ?? '').toLowerCase()
  const tokens = new Set(name.split(/[^a-z0-9]+/).filter(Boolean))
  const libs = vocab.libs ?? {}
  const used = (set: Set<string>) => Object.keys(libs).filter((lib) => set.has(lib)).sort((a, b) => (libs[b] ?? 0) - (libs[a] ?? 0))
  const out: ProjectLens[] = []

  // ---- statistics and machine learning
  {
    let score = 0
    const reasons: string[] = []
    const named = [...ML_NAME_LONG.filter((word) => name.includes(word)), ...[...tokens].filter((token) => ML_NAME_SHORT.has(token))]
    if (named.length) {
      score += Math.min(4, named.length * 2)
      reasons.push(`the folder name (${vocab.project})`)
    }
    const notebooks = count(files, /\.ipynb$/i)
    if (notebooks) {
      score += 2
      reasons.push(`${notebooks} notebook${notebooks === 1 ? '' : 's'}`)
    }
    const data = count(files, /\.(?:csv|tsv|parquet|feather|arrow|h5|hdf5|npz|npy|pkl|pickle)$/i)
    if (data >= 3) {
      score += 2
      reasons.push(`${data} data files`)
    }
    if (count(files, /\.(?:pt|pth|ckpt|safetensors|onnx|joblib|keras)$/i)) {
      score += 2
      reasons.push('saved model weights')
    }
    const split = files.some((path) => /(^|[/_-])train[^/]*\.(?:csv|parquet|jsonl?)$/i.test(path)) &&
      files.some((path) => /(^|[/_-])test[^/]*\.(?:csv|parquet|jsonl?)$/i.test(path))
    if (split) {
      score += 2
      reasons.push('train and test files')
    }
    const submission = files.some((path) => /(^|\/)submission[^/]*$/i.test(path))
    if (submission) {
      score += 2
      reasons.push('a submission file')
    }
    const folders = new Set(files.map((path) => path.split('/')[0]!.toLowerCase()))
    const dirs = ['data', 'notebooks', 'experiments', 'results', 'models', 'benchmarks', 'runs', 'research', 'paper']
      .filter((dir) => folders.has(dir))
    if (dirs.length) {
      score += Math.min(3, dirs.length)
      reasons.push(`${dirs.map((dir) => `${dir}/`).join(', ')}`)
    }
    const ml = used(ML_LIBS)
    if (ml.length) {
      score += 3
      reasons.push(ml.slice(0, 3).join(', '))
    } else if (used(DATA_LIBS).length >= 2) {
      score += 1
      reasons.push(used(DATA_LIBS).slice(0, 2).join(', '))
    }
    if (score >= threshold('ml-research')) {
      // The folder's name says what the project is for and outranks stray files; a submission counts only
      // in a challenge's layout, next to train and test files.
      const rigor: Rigor = COMPETE.some((word) => name.includes(word)) ? 'compete'
        : STUDY.some((word) => name.includes(word)) ? 'study'
        : submission && split ? 'compete'
        : folders.has('paper') || folders.has('research') || count(files, /\.tex$/i) > 0 ? 'study'
        : 'build'
      out.push({ profile: 'ml-research', rigor, score, reasons })
    }
  }

  // ---- system design
  {
    let score = 0
    const reasons: string[] = []
    const deploy = [
      [/(^|\/)Dockerfile[^/]*$/, 'a Dockerfile'], [/(^|\/)(docker-)?compose[^/]*\.ya?ml$/i, 'a compose file'],
      [/\.tf$/, 'Terraform'], [/(^|\/)(k8s|kubernetes|helm|charts)\//i, 'Kubernetes manifests'],
      [/\.proto$/, 'protobuf schemas'], [/(^|\/)openapi[^/]*\.(ya?ml|json)$/i, 'an OpenAPI spec'],
      [/(^|\/)migrations\//i, 'database migrations'],
    ] as const
    for (const [test, label] of deploy) {
      if (files.some((path) => test.test(path))) {
        score += 2
        reasons.push(label)
      }
    }
    const services = used(SYSTEM_LIBS)
    if (services.length) {
      score += Math.min(3, services.length + 1)
      reasons.push(services.slice(0, 3).join(', '))
    }
    if ([...tokens].some((token) => SYSTEM_NAME.has(token))) {
      score += 1
      reasons.push(`the folder name (${vocab.project})`)
    }
    if (score >= threshold('system-design')) out.push({ profile: 'system-design', rigor: 'build', score, reasons })
  }
  return out.sort((a, b) => b.score - a.score)
}

/** Imports and declared dependencies, as `git grep -h -o` prints them, counted by package root. */
export function countLibraries(lines: string): Record<string, number> {
  const libs: Record<string, number> = {}
  for (const raw of lines.split('\n')) {
    const line = raw.trim()
    let name: string | undefined
    let m: RegExpExecArray | null
    if ((m = /^"?(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line))) name = m[1]
    else if ((m = /^(?:from\s+|require\()['"]((?:@[\w.-]+\/)?[\w.-]+)/.exec(line))) name = m[1]
    else if ((m = /^"((?:@[\w.-]+\/)?[\w.-]+)"\s*:/.exec(line))) name = m[1]
    else if ((m = /^(?:-\s+)?"?([A-Za-z][A-Za-z0-9_.-]*)\s*(?:[=<>~!\[;"]|$)/.exec(line))) name = m[1]
    if (!name || name.startsWith('.')) continue
    const key = name.toLowerCase().replace(/^@[\w.-]+\//, (scope) => scope === '@tensorflow/' ? '' : scope)
      .replace(/^@nestjs\/.*$/, 'nestjs').replace(/^@prisma\/.*$/, 'prisma').replace(/^@grpc\/.*$/, 'grpc')
      .replace(/^tfjs.*$/, 'tfjs')
    libs[key] = (libs[key] ?? 0) + 1
  }
  return libs
}
