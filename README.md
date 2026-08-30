# Planuze Pack Scan Runner

Este repositório público executa o scan central atestado usado por releases de packs
originados fora do GitHub Actions. Ele não recebe código-fonte por checkout, não recebe
identificadores do artefato como input e não armazena artifacts do GitHub.

## Fronteira de confiança

O Registry da Planuze envia um `workflow_dispatch` sem inputs para um dispatcher
versionado. Esse dispatcher chama um reusable workflow fixado por SHA. Somente o job
do reusable recebe `id-token: write`; o Registry valida `job_workflow_ref`,
`job_workflow_sha`, `run_id`, audiência, tempo e `jti` antes de liberar os bytes
cifrados e a content key individual daquele upload.

O comando executado pelo reusable é deliberadamente estático:

```text
planuze pack scan-upload --ci-mode
```

Upload ID, checksum, URL de artifact, content key, manifest, filenames e findings não
entram em inputs, `with`, environment, argv, artifacts, caches ou logs. O Registry
resolve o upload exclusivamente pelo `run_id` do token OIDC. A CLI baixa o blob
cifrado, confere tamanho e SHA-256, decifra em diretório temporário, escaneia o
snapshot exato, atesta o relatório e limpa buffers mutáveis e arquivos temporários em
regime best-effort tanto em sucesso quanto em falha.

## Três commits imutáveis

O rollout nunca aponta para `main`:

1. **H2** contém a action de runtime e o lock completo da CLI
   `@planuze/pack-publisher@0.4.1`.
2. **H3**, necessariamente posterior, adiciona
   `.github/workflows/pack-scan-central.yml` referenciando a action remota exatamente
   em H2. Isso evita depender do workspace do caller ou de checkout.
3. **H4**, necessariamente posterior, adiciona
   `.github/workflows/pack-scan-dispatch.yml` chamando o reusable exatamente em H3.
4. A tag protegida `pack-scan-dispatch-v1` aponta uma única vez para H4. Atualizações
   futuras criam uma nova tag versionada; a tag v1 não pode ser movida ou apagada.

O Worker `planuze-pack-registry` guarda H3 e H4 de forma independente. Antes de
vincular um run ao upload, ele relê a execução pela API do GitHub e exige
`event=workflow_dispatch` e `head_sha=H4`.

## Runtime congelado

O reusable usa Node 24.16.0 e chama a action remota fixada em H2. Essa action instala a CLI a partir de
`.github/actions/pack-scan-runtime/package-lock.json`. A instalação ocorre fora do
workspace, com ambiente npm limpo, registry oficial fixo, lifecycle scripts
desativados e integridades do lock verificadas. O checkout de qualquer publisher não
é lido nem executado.

Para validar o repositório:

```bash
npm run verify
```

O gate verifica os invariantes dos workflows, o pin por SHA das actions, o comando
estático, a ausência de inputs/secrets/artifacts/cache e o grafo npm com integridade.

## Configuração obrigatória do repositório

Este repositório deve permanecer **público**, com `main` como branch padrão. O runner
não usa repository secrets, environment secrets nem repository variables; em
particular, o token usado pelo Registry para disparar o workflow pertence somente ao
Worker da Cloudflare e nunca deve ser copiado para cá.

Em **Settings → Actions → General**:

- permita somente actions da Planuze e as actions oficiais exigidas pelos workflows
  (`actions/checkout` e `actions/setup-node`), sempre referenciadas por SHA;
- mantenha a permissão padrão do `GITHUB_TOKEN` em leitura e desative a criação ou
  aprovação de pull requests pelo token;
- não habilite runners self-hosted para estes workflows.

Proteja `main` exigindo os dois checks do workflow `Verify runner invariants`:
`Verify immutable source and workflow policy` e `Verify locked runtime boundary`.
Antes de criar a tag, configure um ruleset para `pack-scan-dispatch-v1` que bloqueie
atualização e exclusão; a tag só pode ser criada depois de H4 passar pelos gates
locais e remotos. Crie uma tag
**lightweight** apontando diretamente para H4, pois o probe do Registry rejeita tags
anotadas. Enquanto v1 estiver ativa, mantenha `pack-scan-dispatch.yml` presente e
ativo na branch padrão; a API registra workflows pela branch padrão mesmo quando o
dispatch seleciona a tag imutável. Habilite também Private Vulnerability Reporting
para que incidentes não sejam expostos em issues.

Runs e logs deste repositório público também são públicos. Por isso, uma mudança que
adicione inputs, secrets, checkout do caller, cache, artifacts, runner self-hosted ou
qualquer identificador de upload deve falhar na revisão, mesmo que o YAML seja válido.

## Rotação

Uma alteração no grafo da CLI exige um novo H2 e uma alteração no reusable exige um
novo H3, sempre fixado no H2 correspondente. Depois, um novo dispatcher H4 deve fixar
H3 e uma nova tag imutável deve ser criada. Só após um canário completo o Registry
troca os seletores e libera o modo central para todos os publishers.

A decisão arquitetural e o checklist operacional estão no repositório `cms`:

- `docs/adrs/0890-publicacao-multiprovedor-usa-scan-central-atestado.md`;
- `docs/production-deployment-secrets-checklist.md`, seção “Ativar o scan central
  multiprovedor”.
