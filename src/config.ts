// Configuração do processo. Função PURA sobre o ambiente: quem lê o arquivo é o
// index.ts. Assim o teste não precisa de .env no disco, e o boot falha alto e
// cedo — variável faltando derruba o serviço na largada, não no primeiro job.
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    // Default derivado do HOME: quem instala não precisa declarar o óbvio, e
    // um destino que não existe já é recusado com a lista dos que existem.
    projetosDir: env.PROJETOS_DIR?.trim() || join(env.HOME ?? homedir(), 'projetos'),
    heygenPerfilChrome: env.HEYGEN_PERFIL_CHROME?.trim()
      || join(env.HOME ?? homedir(), '.cache', 'inemaccbot', 'perfil-heygen'),
    chatsPermitidos,
    heygenEnvPath: env.HEYGEN_ENV_PATH?.trim()
      || join(env.HOME ?? homedir(), 'projetos', 'openpcbotv2', '.env'),
    heygenCli: env.HEYGEN_CLI?.trim() || 'heygen',
    motorPadrao: env.MOTOR_PADRAO?.trim() || 'claude',
    modeloPadrao: env.MODELO_PADRAO?.trim() || 'sonnet',
    esforcoPadrao: env.ESFORCO_PADRAO?.trim() || 'low',
    publicoDir: env.PUBLICO_DIR?.trim()
      || join(env.HOME ?? homedir(), 'projetos', 'output', 'reels'),
    publicoUrls: (env.PUBLICO_URLS?.trim() || '')
      .split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean),
  };
}
