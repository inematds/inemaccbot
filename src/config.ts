// Configuração do processo. Função PURA sobre o ambiente: quem lê o arquivo é o
// index.ts. Assim o teste não precisa de .env no disco, e o boot falha alto e
// cedo — variável faltando derruba o serviço na largada, não no primeiro job.
export interface Config {
  botToken: string;
  queueDb: string;
  stateDir: string;
  logFile: string;
  chatsPermitidos: number[];
  motorPadrao: string;
  modeloPadrao: string;
  esforcoPadrao: string;
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
    chatsPermitidos,
    motorPadrao: env.MOTOR_PADRAO?.trim() || 'claude',
    modeloPadrao: env.MODELO_PADRAO?.trim() || 'sonnet',
    esforcoPadrao: env.ESFORCO_PADRAO?.trim() || 'low',
  };
}
