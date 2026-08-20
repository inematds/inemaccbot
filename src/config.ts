// Configuração do processo. Função PURA sobre o ambiente: quem lê o arquivo é o
// index.ts. Assim o teste não precisa de .env no disco, e o boot falha alto e
// cedo — variável faltando derruba o serviço na largada, não no primeiro job.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pasta que contém ESTE clone. Os repos de domínio (`promoavatar`,
 * `promoavatar3`) são clonados como IRMÃOS do inemaccbot — sempre foram, em
 * toda máquina —, então o pai do clone é um default melhor que `$HOME/projetos`:
 * acerta quando o clone não está no HOME (uma VPS com `/root/projetos`, `/opt`,
 * `/srv`) e quando o serviço roda com outro usuário. Vale de `src/` e de
 * `dist/`, que estão ambos um nível abaixo da raiz do repo. */
const PAI_DO_CLONE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface Config {
  botToken: string;
  queueDb: string;
  stateDir: string;
  logFile: string;
  /** Onde ficam os repos `yt-pub-livesN` — a raiz do registry de destinos. */
  projetosDir: string;
  chatsPermitidos: number[];
  /** Arquivo com a HEYGEN_API_KEY (lida em runtime). */
  heygenEnvPath: string;
  /** Binário da CLI `heygen` — a rota de créditos (OAuth). CAMINHO, não
   *  segredo: o token expira e quem renova é a própria CLI. */
  heygenCli: string;
  /** Perfil de Chromium JÁ LOGADO no HeyGen, usado pela rota `| estudio`.
   *  CAMINHO, não segredo — os cookies moram lá dentro e não no repo. */
  heygenPerfilChrome: string;
  /** Binário do motor `claude`, por caminho — ver o porquê no `carregarConfig`. */
  claudeBin: string;
  /** Binário do motor `codex` (opcional) — mesmo motivo do `claudeBin`: caminho,
   *  não PATH. Ausente na máquina só quebra quem pedir `| motor=codex`. */
  codexBin: string;
  /** Binário do motor `opencode` (opcional). Idem. */
  opencodeBin: string;
  motorPadrao: string;
  modeloPadrao: string;
  esforcoPadrao: string;
  /**
   * Pasta que um servidor HTTP já serve (o `python -m http.server 8202` sobre
   * `~/projetos/output/reels`). O vídeo final do fluxo é copiado para cá com o
   * nome do título, e é isso que vira link no chat.
   */
  publicoDir: string;
  /**
   * Bases de URL que apontam para `publicoDir`. São DUAS porque a máquina fica
   * nas duas redes ao mesmo tempo (ver `~/projetos/wifi/dual-network.sh`) e o
   * celular está em uma delas — mandar os dois links evita depender de DNS,
   * que não existe para um nome tipo `rede` fora desta máquina.
   */
  publicoUrls: string[];
}

function exigir(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) throw new Error(`config: falta ${nome} no ambiente`);
  return v;
}

export function carregarConfig(env: NodeJS.ProcessEnv): Config {
  const bruta = exigir(env, 'ALLOWED_CHAT_IDS');
  const chatsPermitidos = bruta.split(',').map((p) => {
    const t = p.trim();
    const n = Number(t);
    // Allowlist é a única barreira entre o bot e qualquer pessoa no Telegram:
    // entrada inválida é erro de boot, nunca "ignora e segue".
    if (!t || !Number.isInteger(n)) throw new Error(`config: ALLOWED_CHAT_IDS inválido: "${t}"`);
    return n;
  });

  return {
    botToken: exigir(env, 'BOT_TOKEN'),
    queueDb: exigir(env, 'QUEUE_DB'),
    stateDir: exigir(env, 'STATE_DIR'),
    logFile: exigir(env, 'LOG_FILE'),
    // Default derivado do CLONE, não do HOME: quem instala não precisa declarar
    // o óbvio, e um destino que não existe já é recusado com a lista dos que
    // existem. Ver PAI_DO_CLONE.
    projetosDir: env.PROJETOS_DIR?.trim() || PAI_DO_CLONE,
    heygenPerfilChrome: env.HEYGEN_PERFIL_CHROME?.trim()
      || join(env.HOME ?? homedir(), '.cache', 'inemaccbot', 'perfil-heygen'),
    chatsPermitidos,
    // COFRE: qualquer arquivo com uma linha `HEYGEN_API_KEY=`. O default é o
    // `wifi/.env`, o cofre único do ecossistema — antes apontava para o `.env`
    // de outro projeto, que numa VPS quase nunca existe, e aí a rota `| api`
    // falhava por um default que só valia na máquina de origem.
    heygenEnvPath: env.HEYGEN_ENV_PATH?.trim()
      || join(env.HOME ?? homedir(), 'projetos', 'wifi', '.env'),
    heygenCli: env.HEYGEN_CLI?.trim() || 'heygen',
    // O binário do motor `claude`, por CAMINHO e não pelo PATH.
    //
    // Custou o C#77 e o C#78: o serviço systemd roda com o PATH mínimo (sem
    // `~/.local/bin`), então `claude` resolvia para `/usr/bin/claude` — uma
    // instalação de MARÇO (2.1.63) que bloqueia `mkdir` e pede permissão a cada
    // `Write`. Sem ninguém na frente do terminal, os dois fluxos terminaram sem
    // escrever um arquivo sequer. Os fluxos anteriores só passaram porque
    // aquele processo tinha sido iniciado de um shell, com o PATH do usuário —
    // ou seja, qual CLI o bot usa dependia de COMO o serviço tinha subido.
    //
    // Default derivado do HOME (a instalação por usuário, que é a que se
    // atualiza), e não a string `claude`: PATH é justamente o que não se pode
    // confiar aqui.
    claudeBin: env.CLAUDE_BIN?.trim()
      || join(env.HOME ?? homedir(), '.local', 'bin', 'claude'),
    // Motores ALTERNATIVOS. Default derivado do HOME pelo mesmo motivo do
    // `claudeBin` (PATH do systemd é mínimo): o `codex` instalado por npm global
    // mora em `~/.npm-global/bin`, o `opencode` em `~/.opencode/bin`. Não
    // existir não é erro de boot — ver `criarServico` em `index.ts`.
    codexBin: env.CODEX_BIN?.trim()
      || join(env.HOME ?? homedir(), '.npm-global', 'bin', 'codex'),
    opencodeBin: env.OPENCODE_BIN?.trim()
      || join(env.HOME ?? homedir(), '.opencode', 'bin', 'opencode'),
    motorPadrao: env.MOTOR_PADRAO?.trim() || 'claude',
    modeloPadrao: env.MODELO_PADRAO?.trim() || 'sonnet',
    esforcoPadrao: env.ESFORCO_PADRAO?.trim() || 'low',
    publicoDir: env.PUBLICO_DIR?.trim()
      || join(env.HOME ?? homedir(), 'projetos', 'output', 'reels'),
    publicoUrls: (env.PUBLICO_URLS?.trim() || '')
      .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean),
  };
}
