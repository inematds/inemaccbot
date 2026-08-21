// Catálogo FECHADO de tarefas `function` (spec §9): o campo `tarefa` de um job
// só pode ser uma chave daqui. Texto livre do usuário nunca vira nome de tarefa.
import { readFileSync } from 'node:fs';

import type { Tarefa } from '../worker.js';
import { criarHttpGet } from './http.js';
import { criarFfmpegThumb } from './ffmpeg.js';
import { criarClienteHeygen, criarHeygenBaixar, criarHeygenGerar, lerChaveHeygen } from './heygen.js';
import { clienteViaCli, rodarCliReal } from './heygen-cli.js';
import { criarReelMontar, disparoReal } from './reel.js';
import { criarHeygenEstudio } from './heygen-estudio.js';
import { criarCliRodar } from './cli.js';
import { criarSkillCli } from './skill-cli.js';
import type { SkillDef } from '../../dominio/registry.js';

export function criarTarefas(opts: {
  raizMidia: string;
  /** Arquivo de onde a HEYGEN_API_KEY é lida EM RUNTIME (nunca no repo, §9). */
  heygenEnvPath?: string;
  /** Binário da CLI `heygen` (rota de créditos). CAMINHO, não segredo: o token
   *  OAuth expira e quem o renova é a própria CLI, em `~/.config/heygen`. */
  heygenCli?: string;
  /** Perfil de Chromium logado no HeyGen (rota `| estudio`). */
  heygenPerfilChrome?: string;
  /** `scripts/heygen-estudio.mjs` — o roteiro do estúdio, sem agente. */
  heygenEstudioScript?: string;
  /** Skills que declaram `comando`: cada uma vira uma tarefa `function` com o
   *  nome do próprio comando. É a rota de skill sem agente. */
  skills?: SkillDef[];
  raizArtefatos?: string;
  projetosDir?: string;
}): Record<string, Tarefa> {
  const cliente = criarClienteHeygen(
    () => lerChaveHeygen(opts.heygenEnvPath ?? '', (p) => readFileSync(p, 'utf8')),
  );
  return {
    'http.get': criarHttpGet(),
    'ffmpeg.thumb': criarFfmpegThumb('ffmpeg', opts.raizMidia),
    // A chave é lida a cada chamada, não no boot: trocar o `.env` passa a valer
    // sem reiniciar, e a chave nunca fica pendurada em memória de propósito.
    'heygen.baixar': criarHeygenBaixar(cliente),
    // Só é alcançada por um fluxo criado com `| api` — a fase `gerar` não
    // existe na definição congelada de um fluxo normal.
    'heygen.gerar': criarHeygenGerar(cliente),
    // Mesma tarefa, outra AUTENTICAÇÃO: a CLI autentica como a conta web e
    // debita da assinatura em vez da carteira em dólar.
    'heygen.gerar-creditos': criarHeygenGerar(
      clienteViaCli(cliente, rodarCliReal(opts.heygenCli ?? 'heygen')),
    ),
    // A fase de reel SEM agente. O contrato com `render.ts` é o mesmo do
    // caminho de agente (`.pid`/`.log`/`.err`); o que sai é o modelo.
    'reel.montar': criarReelMontar({ disparar: disparoReal() }),
    // A rota `| estudio`: mesmo efeito e mesma cobrança do `| navega`, com um
    // script no lugar do agente. O `navega` fica de pé como caminho de volta.
    // O CLI do domínio, sem agente: o comando é declarado no `flow.json` da
    // fase e o bot o executa. Genérica de propósito — serve a qualquer domínio
    // com linha de comando, e é o que impede o próximo de nascer com um prompt
    // explicando a um modelo como rodar o próprio script.
    'cli.rodar': criarCliRodar(),
    'heygen.estudio': criarHeygenEstudio(cliente, {
      perfil: opts.heygenPerfilChrome ?? '',
      script: opts.heygenEstudioScript ?? 'scripts/heygen-estudio.mjs',
    }),
    // Uma tarefa por SKILL que declara `comando`. O nome é o do próprio
    // comando porque é isso que o job carrega em `tarefa` — o worker procura
    // aqui quando `kind: function`. Skill sem `comando` continua sendo agente e
    // não aparece neste mapa.
    ...Object.fromEntries((opts.skills ?? [])
      .filter((s) => s.comando)
      .map((s) => [s.command, criarSkillCli(s, {
        raizArtefatos: opts.raizArtefatos ?? opts.raizMidia,
        projetosDir: opts.projetosDir ?? '',
      })])),
  };
}
