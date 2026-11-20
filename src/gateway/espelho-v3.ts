// Aviso de fluxo cujo pedido NASCEU no v3 volta para o v3 (Nei, 20/11/2026:
// "este tipo de erro não tem que aparecer no painel, tem que ir para a fonte,
// que é o v3"). Aprovação, dúvida e falha de pedido do v3 são respondidas lá.
//
// O inemaccbot não tem o token do v3: usa os dois scripts do wifi que já leem
// as credenciais em runtime (`avisa-v3.sh` texto, `envia-v3-arquivo.sh` anexo).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export { pedidoDoV3 } from '../dominio/origem-v3.js';

export interface EventoV3 {
  texto: string;
  anexo?: string;
}

type Rodar = (bin: string, args: string[]) => Promise<void>;

const rodarPadrao: Rodar = (bin, args) => new Promise((ok, falha) => {
  execFile(bin, args, { timeout: 150_000 }, (erro, _out, err) => {
    if (erro) falha(new Error(`${bin}: ${err?.toString().trim() || erro.message}`));
    else ok();
  });
});

/** Manda texto (e anexo, se houver) ao v3. Erro sobe para quem chamou registrar. */
export function criarEspelhoV3(
  dir = process.env.V3_SCRIPTS_DIR ?? join(homedir(), 'projetos', 'wifi', 'scripts'),
  rodar: Rodar = rodarPadrao,
): (e: EventoV3) => Promise<void> {
  return async (e) => {
    await rodar(join(dir, 'avisa-v3.sh'), [`inemaccbot · ${e.texto}`]);
    if (e.anexo && existsSync(e.anexo)) {
      await rodar(join(dir, 'envia-v3-arquivo.sh'), [e.anexo]);
    }
  };
}
