import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const exists = (path) => existsSync(join(root, path));
const centralPath = '.github/workflows/pack-scan-central.yml';
const dispatchPath = '.github/workflows/pack-scan-dispatch.yml';
const ciPath = '.github/workflows/ci.yml';
const actionPath = '.github/actions/pack-scan-runtime/action.yml';
const runtimePackagePath = '.github/actions/pack-scan-runtime/package.json';
const lockPath = '.github/actions/pack-scan-runtime/package-lock.json';
const pendingPath = '.github/actions/pack-scan-runtime/LOCK_PENDING';
const rootPackagePath = 'package.json';
const expectedCliVersion = '0.4.3';
const expectedCheckoutUse = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const expectedSetupNodeUse =
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';
// Construído em partes para que o repositório final não carregue um placeholder literal.
const pendingH2Ref = '<H2' + '_SHA>';
const allowPendingLock = process.argv.includes('--allow-pending-lock');
const allowPendingRefs = process.argv.includes('--allow-pending-refs');
const runtimeOnly = process.argv.includes('--runtime-only');

const action = read(actionPath);
const runtimePackage = JSON.parse(read(runtimePackagePath));

const includes = (source, fragment, label) =>
  assert.ok(source.includes(fragment), `${label}: trecho obrigatório ausente: ${fragment}`);
const excludes = (source, fragment, label) =>
  assert.ok(!source.includes(fragment), `${label}: trecho proibido presente: ${fragment}`);
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const committedFile = (sha, path) => git(['show', `${sha}:${path}`]);
const yaml = (path) => parse(read(path));
const exactKeys = (value, expected, label) => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: objeto esperado`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label}: chaves inesperadas`);
};
const assertReviewedShell = (source, expectedSha256, label) => {
  assert.equal(typeof source, 'string', `${label}: bloco shell ausente`);
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    expectedSha256,
    `${label}: bloco shell divergiu da versão revisada`,
  );
};

includes(action, 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund', actionPath);
includes(action, "NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'", actionPath);
includes(action, 'env -i', actionPath);
includes(action, 'LOCK_PENDING', actionPath);
includes(action, 'realpath -e', actionPath);
includes(action, 'RUNNER_TEMP', actionPath);
excludes(action, 'npm install ', actionPath);
const actionDocument = yaml(actionPath);
exactKeys(actionDocument, ['name', 'description', 'outputs', 'runs'], actionPath);
exactKeys(actionDocument.outputs, ['cli_path', 'install_root'], `${actionPath} outputs`);
assert.equal(
  actionDocument.outputs.cli_path?.value,
  '${{ steps.runtime.outputs.cli_path }}',
  `${actionPath}: output cli_path divergente`,
);
assert.equal(
  actionDocument.outputs.install_root?.value,
  '${{ steps.runtime.outputs.install_root }}',
  `${actionPath}: output install_root divergente`,
);
exactKeys(actionDocument.runs, ['using', 'steps'], `${actionPath} runs`);
assert.equal(actionDocument.runs.using, 'composite', `${actionPath}: action precisa ser composite`);
assert.equal(actionDocument.runs.steps.length, 1, `${actionPath}: somente um step é permitido`);
exactKeys(
  actionDocument.runs.steps[0],
  ['name', 'id', 'shell', 'env', 'run'],
  `${actionPath} runtime step`,
);
assert.equal(actionDocument.runs.steps[0].shell, 'bash', `${actionPath}: shell precisa ser bash`);
assert.equal(actionDocument.runs.steps[0].id, 'runtime', `${actionPath}: id do runtime divergente`);
assert.deepEqual(
  actionDocument.runs.steps[0].env,
  { PLANUZE_ACTION_PATH: '${{ github.action_path }}' },
  `${actionPath}: env não autorizado`,
);
// Estes digests são fronteiras de revisão, não checksums obtidos do próprio arquivo.
// Alterar shell do runtime exige revisão explícita e um novo H2 imutável.
assertReviewedShell(
  actionDocument.runs.steps[0].run,
  '3675022092fffab5325242bb8cb95c5c46ed87511049af3374e2fe5d28b646d7',
  `${actionPath} runtime step`,
);
execFileSync('bash', ['-n'], {
  input: actionDocument.runs.steps[0].run,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
assert.equal(
  runtimePackage.dependencies?.['@planuze/pack-publisher'],
  expectedCliVersion,
  `${runtimePackagePath}: CLI precisa estar fixada em ${expectedCliVersion}`,
);

const lockExists = exists(lockPath);
const pendingExists = exists(pendingPath);
if (!allowPendingLock) {
  assert.ok(lockExists, `${lockPath}: lock imutável ausente`);
  assert.ok(!pendingExists, `${pendingPath}: marker precisa ser removido antes de H2`);
}
if (lockExists) {
  const lock = JSON.parse(read(lockPath));
  assert.equal(lock.lockfileVersion, 3, `${lockPath}: lockfileVersion inesperada`);
  assert.equal(
    lock.packages?.['']?.dependencies?.['@planuze/pack-publisher'],
    expectedCliVersion,
    `${lockPath}: dependência raiz divergente`,
  );
  assert.equal(
    lock.packages?.['node_modules/@planuze/pack-publisher']?.version,
    expectedCliVersion,
    `${lockPath}: pacote instalado divergente`,
  );
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/')) continue;
    assert.notEqual(entry.link, true, `${lockPath}: ${path} não pode ser link`);
    assert.match(entry.integrity ?? '', /^sha512-/, `${lockPath}: ${path} sem integridade SHA-512`);
    assert.ok(
      entry.resolved?.startsWith('https://registry.npmjs.org/'),
      `${lockPath}: ${path} usa origem não autorizada`,
    );
  }
}

if (runtimeOnly) {
  process.stdout.write('Runtime H2: invariantes verificadas.\n');
  process.exit(0);
}

assert.ok(exists(centralPath), `${centralPath}: reusable central ausente`);
assert.ok(exists(ciPath), `${ciPath}: workflow de verificação ausente`);
const workflowEntries = readdirSync(join(root, '.github/workflows'), { withFileTypes: true });
assert.ok(
  workflowEntries.every((entry) => entry.isFile()),
  '.github/workflows: subdiretórios não são permitidos',
);
const expectedWorkflowPaths = [
  ciPath,
  centralPath,
  ...(exists(dispatchPath) ? [dispatchPath] : []),
].sort();
assert.deepEqual(
  workflowEntries.map((entry) => `.github/workflows/${entry.name}`).sort(),
  expectedWorkflowPaths,
  '.github/workflows: workflow inesperado presente',
);
const central = read(centralPath);
const ci = read(ciPath);
const rootPackage = JSON.parse(read(rootPackagePath));
const centralDocument = yaml(centralPath);
const ciDocument = yaml(ciPath);
if (!allowPendingRefs) {
  assert.doesNotMatch(central, /<H[234]_SHA>/u, `${centralPath}: placeholder imutável vazou`);
  assert.doesNotMatch(ci, /<H[234]_SHA>/u, `${ciPath}: placeholder imutável vazou`);
  assert.equal(
    rootPackage.scripts?.verify,
    'node scripts/verify.mjs',
    `${rootPackagePath}: H3 precisa ativar o gate completo no CI`,
  );
}

exactKeys(centralDocument, ['name', 'on', 'permissions', 'jobs'], centralPath);
exactKeys(centralDocument.on, ['workflow_call'], `${centralPath} on`);
assert.equal(centralDocument.on.workflow_call, null, `${centralPath}: workflow_call não aceita config`);
assert.deepEqual(centralDocument.permissions, {}, `${centralPath}: permissões top-level precisam ser vazias`);
exactKeys(centralDocument.jobs, ['scan'], `${centralPath} jobs`);
const centralJob = centralDocument.jobs.scan;
exactKeys(
  centralJob,
  ['name', 'runs-on', 'timeout-minutes', 'permissions', 'steps'],
  `${centralPath} scan job`,
);
assert.equal(centralJob['runs-on'], 'ubuntu-24.04', `${centralPath}: runner precisa ser hospedado`);
assert.equal(centralJob['timeout-minutes'], 10, `${centralPath}: timeout divergente`);
assert.deepEqual(
  centralJob.permissions,
  { 'id-token': 'write' },
  `${centralPath}: somente id-token write é permitido`,
);
assert.equal(centralJob.steps.length, 4, `${centralPath}: quantidade de steps divergente`);
exactKeys(centralJob.steps[0], ['name', 'uses', 'with'], `${centralPath} setup step`);
assert.equal(
  centralJob.steps[0].uses,
  expectedSetupNodeUse,
  `${centralPath}: setup-node não corresponde ao commit revisado`,
);
assert.deepEqual(
  centralJob.steps[0].with,
  { 'node-version': '24.16.0', 'registry-url': 'https://registry.npmjs.org' },
  `${centralPath}: runtime Node divergente`,
);
exactKeys(centralJob.steps[1], ['name', 'id', 'uses'], `${centralPath} action step`);
assert.equal(centralJob.steps[1].id, 'cli', `${centralPath}: id da action divergente`);
exactKeys(centralJob.steps[2], ['name', 'shell', 'env', 'run'], `${centralPath} scan step`);
assert.equal(centralJob.steps[2].shell, 'bash', `${centralPath}: shell do scan precisa ser bash`);
assert.deepEqual(
  centralJob.steps[2].env,
  { PLANUZE_CLI_PATH: '${{ steps.cli.outputs.cli_path }}' },
  `${centralPath}: env do scan divergente`,
);
exactKeys(centralJob.steps[3], ['name', 'if', 'shell', 'env', 'run'], `${centralPath} cleanup step`);
assert.equal(centralJob.steps[3].if, 'always()', `${centralPath}: cleanup precisa rodar sempre`);
assert.equal(centralJob.steps[3].shell, 'bash', `${centralPath}: shell do cleanup precisa ser bash`);
assert.deepEqual(
  centralJob.steps[3].env,
  { CLI_INSTALL_ROOT: '${{ steps.cli.outputs.install_root }}' },
  `${centralPath}: env do cleanup divergente`,
);
// Alterar qualquer um destes blocos exige revisão explícita e um novo H3 imutável.
assertReviewedShell(
  centralJob.steps[2].run,
  '834024a737bc9dcf37bcb7588bce24fc62c6f78391eb63dba75d3402a6e7b0ef',
  `${centralPath} scan step`,
);
assertReviewedShell(
  centralJob.steps[3].run,
  '2159d6da4d734c3ba065e3fde794f5741ce1e756a23472161ff451b28f733188',
  `${centralPath} cleanup step`,
);

exactKeys(ciDocument, ['name', 'on', 'permissions', 'jobs'], ciPath);
exactKeys(ciDocument.on, ['pull_request', 'push'], `${ciPath} on`);
assert.equal(ciDocument.on.pull_request, null, `${ciPath}: pull_request não aceita config`);
assert.deepEqual(ciDocument.on.push, { branches: ['main'] }, `${ciPath}: push divergente`);
assert.deepEqual(ciDocument.permissions, { contents: 'read' }, `${ciPath}: permissões divergentes`);
exactKeys(ciDocument.jobs, ['verify', 'runtime-boundary'], `${ciPath} jobs`);
const verifyJob = ciDocument.jobs.verify;
exactKeys(verifyJob, ['name', 'runs-on', 'timeout-minutes', 'steps'], `${ciPath} verify job`);
assert.equal(
  verifyJob.name,
  'Verify immutable source and workflow policy',
  `${ciPath}: nome estável do check verify divergente`,
);
assert.equal(verifyJob['runs-on'], 'ubuntu-24.04', `${ciPath}: runner do verify divergente`);
assert.equal(verifyJob['timeout-minutes'], 10, `${ciPath}: timeout do verify divergente`);
assert.equal(verifyJob.steps.length, 5, `${ciPath}: quantidade de steps do verify divergente`);
exactKeys(verifyJob.steps[0], ['name', 'uses', 'with'], `${ciPath} checkout step`);
assert.equal(
  verifyJob.steps[0].uses,
  expectedCheckoutUse,
  `${ciPath}: checkout não corresponde ao commit revisado`,
);
assert.deepEqual(
  verifyJob.steps[0].with,
  { 'fetch-depth': 0, 'persist-credentials': false },
  `${ciPath}: checkout precisa do histórico completo e sem credencial persistida`,
);
exactKeys(verifyJob.steps[1], ['name', 'uses', 'with'], `${ciPath} setup step`);
assert.equal(
  verifyJob.steps[1].uses,
  expectedSetupNodeUse,
  `${ciPath}: setup-node não corresponde ao commit revisado`,
);
assert.deepEqual(
  verifyJob.steps[1].with,
  { 'node-version': '24.16.0' },
  `${ciPath}: Node do verify divergente`,
);
exactKeys(verifyJob.steps[2], ['name', 'run'], `${ciPath} install step`);
assert.equal(
  verifyJob.steps[2].run,
  'npm ci --ignore-scripts --no-audit --no-fund',
  `${ciPath}: instalação do parser precisa ser imutável`,
);
exactKeys(verifyJob.steps[3], ['name', 'run'], `${ciPath} contract step`);
assert.equal(verifyJob.steps[3].run, 'npm run verify', `${ciPath}: gate estrito ausente`);
exactKeys(verifyJob.steps[4], ['name', 'run'], `${ciPath} actionlint step`);
assert.equal(
  verifyJob.steps[4].run,
  'bash scripts/verify-actionlint-linux.sh',
  `${ciPath}: actionlint pinado ausente`,
);
const runtimeJob = ciDocument.jobs['runtime-boundary'];
exactKeys(
  runtimeJob,
  ['name', 'runs-on', 'timeout-minutes', 'permissions', 'steps'],
  `${ciPath} runtime job`,
);
assert.equal(
  runtimeJob.name,
  'Verify locked runtime boundary',
  `${ciPath}: nome estável do check boundary divergente`,
);
assert.equal(runtimeJob['runs-on'], 'ubuntu-24.04', `${ciPath}: runner do boundary divergente`);
assert.equal(runtimeJob['timeout-minutes'], 10, `${ciPath}: timeout do boundary divergente`);
assert.deepEqual(runtimeJob.permissions, { contents: 'read' }, `${ciPath}: runtime permissions`);
assert.equal(runtimeJob.steps.length, 4, `${ciPath}: quantidade de runtime steps divergente`);
exactKeys(runtimeJob.steps[0], ['name', 'uses', 'with'], `${ciPath} runtime setup step`);
assert.equal(
  runtimeJob.steps[0].uses,
  expectedSetupNodeUse,
  `${ciPath}: setup-node do boundary não corresponde ao commit revisado`,
);
assert.deepEqual(
  runtimeJob.steps[0].with,
  { 'node-version': '24.16.0', 'registry-url': 'https://registry.npmjs.org' },
  `${ciPath}: Node do runtime divergente`,
);
exactKeys(runtimeJob.steps[1], ['name', 'id', 'uses'], `${ciPath} runtime action step`);
assert.equal(runtimeJob.steps[1].id, 'cli', `${ciPath}: id da runtime action divergente`);
exactKeys(runtimeJob.steps[2], ['name', 'shell', 'env', 'run'], `${ciPath} boundary step`);
assert.equal(runtimeJob.steps[2].shell, 'bash', `${ciPath}: boundary shell precisa ser bash`);
assert.deepEqual(
  runtimeJob.steps[2].env,
  { PLANUZE_CLI_PATH: '${{ steps.cli.outputs.cli_path }}' },
  `${ciPath}: boundary env divergente`,
);
exactKeys(runtimeJob.steps[3], ['name', 'if', 'shell', 'env', 'run'], `${ciPath} cleanup step`);
assert.equal(runtimeJob.steps[3].if, 'always()', `${ciPath}: cleanup precisa rodar sempre`);
assert.equal(runtimeJob.steps[3].shell, 'bash', `${ciPath}: cleanup shell precisa ser bash`);
assert.deepEqual(
  runtimeJob.steps[3].env,
  { CLI_INSTALL_ROOT: '${{ steps.cli.outputs.install_root }}' },
  `${ciPath}: cleanup env divergente`,
);
assertReviewedShell(
  runtimeJob.steps[2].run,
  '307eb05da0f3c23e6a11eccfe8350df48e39763fa036f722562cbff097feaae7',
  `${ciPath} boundary step`,
);
assertReviewedShell(
  runtimeJob.steps[3].run,
  '2159d6da4d734c3ba065e3fde794f5741ce1e756a23472161ff451b28f733188',
  `${ciPath} cleanup step`,
);
assert.match(
  verifyJob.steps[0].uses,
  /^actions\/checkout@[a-f0-9]{40}$/,
  `${ciPath}: checkout precisa de SHA completo`,
);
assert.match(
  verifyJob.steps[1].uses,
  /^actions\/setup-node@[a-f0-9]{40}$/,
  `${ciPath}: setup-node precisa de SHA completo`,
);
assert.match(
  runtimeJob.steps[0].uses,
  /^actions\/setup-node@[a-f0-9]{40}$/,
  `${ciPath}: setup-node do runtime precisa de SHA completo`,
);
for (const workflowSource of [central, ci]) {
  excludes(workflowSource, 'write-all', 'workflow permissions');
}

includes(central, 'workflow_call:', centralPath);
includes(central, 'id-token: write', centralPath);
includes(central, 'permissions: {}', centralPath);
includes(central, 'runs-on: ubuntu-24.04', centralPath);
includes(central, 'timeout-minutes:', centralPath);
includes(central, '"$cli_path" pack scan-upload --ci-mode', centralPath);
assert.match(
  central,
  /actions\/setup-node@[a-f0-9]{40}/,
  `${centralPath}: setup-node precisa estar fixado por SHA completo`,
);
for (const forbidden of [
  'workflow_dispatch:',
  'inputs:',
  'secrets:',
  'actions/checkout@',
  'actions/cache@',
  'actions/upload-artifact@',
  'contents: write',
  'actions: write',
  'packages: write',
  '${{ inputs.',
  '${{ secrets.',
  'github.event.inputs',
  'curl ',
  'wget ',
  '--endpoint',
  '--upload',
  '--checksum',
  'uses: $/',
  'uses: ./',
]) {
  excludes(central, forbidden, centralPath);
}

const runtimeReferencePattern = new RegExp(
  `^Planuze-Software/pack-scan-runner/\\.github/actions/pack-scan-runtime@([a-f0-9]{40}|${pendingH2Ref})$`,
);
const centralRuntimeUse = centralJob.steps[1].uses;
const ciRuntimeUse = runtimeJob.steps[1]?.uses;
assert.equal(typeof centralRuntimeUse, 'string', `${centralPath}: referência H2 inválida`);
assert.equal(typeof ciRuntimeUse, 'string', `${ciPath}: referência H2 inválida`);
const centralRuntimeRef = centralRuntimeUse.match(runtimeReferencePattern)?.[1];
const ciRuntimeRef = ciRuntimeUse.match(runtimeReferencePattern)?.[1];
assert.ok(centralRuntimeRef, `${centralPath}: action remota H2 ausente`);
assert.equal(ciRuntimeRef, centralRuntimeRef, `${ciPath}: action precisa usar o mesmo H2 do reusable`);
if (centralRuntimeRef === pendingH2Ref) {
  assert.ok(allowPendingRefs, `${centralPath}: placeholder H2 precisa ser substituído`);
} else {
  git(['cat-file', '-e', `${centralRuntimeRef}^{commit}`]);
  assert.equal(
    git([
      'ls-tree',
      '-r',
      '--name-only',
      centralRuntimeRef,
      '--',
      '.github/workflows',
    ]).trim(),
    '',
    'H2 não pode conter qualquer workflow, executável ou placeholder',
  );
  assert.equal(committedFile(centralRuntimeRef, actionPath), action, `${centralPath}: action H2 diverge`);
  assert.equal(
    committedFile(centralRuntimeRef, runtimePackagePath),
    read(runtimePackagePath),
    `${centralPath}: package H2 diverge`,
  );
  assert.equal(
    committedFile(centralRuntimeRef, lockPath),
    read(lockPath),
    `${centralPath}: lock H2 diverge`,
  );
}

if (exists(dispatchPath)) {
  const dispatch = read(dispatchPath);
  const dispatchDocument = yaml(dispatchPath);
  assert.doesNotMatch(dispatch, /<H[234]_SHA>/u, `${dispatchPath}: placeholder imutável vazou`);
  exactKeys(dispatchDocument, ['name', 'on', 'permissions', 'jobs'], dispatchPath);
  exactKeys(dispatchDocument.on, ['workflow_dispatch'], `${dispatchPath} on`);
  assert.equal(
    dispatchDocument.on.workflow_dispatch,
    null,
    `${dispatchPath}: workflow_dispatch não aceita inputs`,
  );
  assert.deepEqual(dispatchDocument.permissions, {}, `${dispatchPath}: permissões top-level vazias`);
  exactKeys(dispatchDocument.jobs, ['scan'], `${dispatchPath} jobs`);
  exactKeys(dispatchDocument.jobs.scan, ['permissions', 'uses'], `${dispatchPath} scan job`);
  assert.deepEqual(
    dispatchDocument.jobs.scan.permissions,
    { 'id-token': 'write' },
    `${dispatchPath}: somente id-token write é permitido`,
  );
  includes(dispatch, 'workflow_dispatch:', dispatchPath);
  includes(dispatch, 'id-token: write', dispatchPath);
  assert.match(
    dispatch,
    /uses: Planuze-Software\/pack-scan-runner\/\.github\/workflows\/pack-scan-central\.yml@[a-f0-9]{40}/,
    `${dispatchPath}: reusable precisa estar fixado por SHA completo`,
  );
  for (const forbidden of ['inputs:', 'secrets:', 'with:', 'runs-on:', 'steps:', 'uses: $/']) {
    excludes(dispatch, forbidden, dispatchPath);
  }
  const centralSha = dispatch.match(/pack-scan-central\.yml@([a-f0-9]{40})/)?.[1];
  assert.ok(centralSha, `${dispatchPath}: SHA H3 ausente`);
  git(['cat-file', '-e', `${centralSha}^{commit}`]);
  if (centralRuntimeRef !== pendingH2Ref) {
    git(['merge-base', '--is-ancestor', centralRuntimeRef, centralSha]);
  }
  assert.equal(
    committedFile(centralSha, centralPath),
    central,
    `${dispatchPath}: H3 não contém o reusable central atual`,
  );
  assert.equal(
    committedFile(centralSha, ciPath),
    ci,
    `${dispatchPath}: H3 não contém o CI atual`,
  );
  assert.deepEqual(
    git(['ls-tree', '-r', '--name-only', centralSha, '--', '.github/workflows'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort(),
    [centralPath, ciPath].sort(),
    `${dispatchPath}: H3 precisa conter somente central e CI`,
  );
  assert.equal(
    JSON.parse(committedFile(centralSha, rootPackagePath)).scripts?.verify,
    'node scripts/verify.mjs',
    `${dispatchPath}: H3 não ativou o gate completo`,
  );
  assert.equal(
    git(['ls-tree', '-r', '--name-only', centralSha, '--', dispatchPath]).trim(),
    '',
    `${dispatchPath}: H3 não pode conter o dispatcher`,
  );
}

process.stdout.write('Runner central: invariantes verificadas.\n');
