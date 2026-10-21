#!/usr/bin/env python3
"""LOOP-R do inemaccbot, camada "medir": falhas e avaliações → SIL Loop R.

Lê o banco do bot SÓ PARA LEITURA (o bot roda em WAL ao lado), agrupa:
  - jobs que falharam, por tarefa + erro normalizado;
  - fases de fluxo que falharam, por tipo + fase + erro;
  - o que o dono disse no portão (tabela `avaliacoes`, migration 5): nota média,
    refazer e respostas, com os motivos.
Escreve o relatório em state/loopr/<data>.md e registra cada grupo NOVO como
ocorrência no SIL do projeto (.sil/, fora do git). Não gasta token, não chama API.

Uso:
  loopr-coletor.py                 # janela de 7 dias, registra no SIL
  loopr-coletor.py --dias 30       # primeira rodada
  loopr-coletor.py --sem-sil       # só o relatório, não registra
  loopr-coletor.py --visto         # marca as ocorrências novas como vistas (o hook para de avisar)
"""
import argparse, datetime, json, re, sqlite3, subprocess, sys, time
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SIL = Path.home() / 'projetos/sil-loop-r/sil.py'
VISTO = RAIZ / '.sil/coletor-visto.json'
NOVAS = RAIZ / '.sil/coletor-novas.json'


def seg(t):
    """O banco mistura segundos e milissegundos (os jobs antigos estão em ms)."""
    if t is None:
        return 0
    return t / 1000 if t > 1e11 else t


def normalizar(erro):
    linha = next((l.strip() for l in str(erro or '').splitlines() if l.strip()), '(sem mensagem)')
    linha = re.sub(r'\S*\d\S*', '#', linha)     # ids, refs C166-…, caminhos com número, tempos
    linha = re.sub(r'(/[\w.~-]+){2,}', '<caminho>', linha)
    return re.sub(r'\s+', ' ', linha)[:140]


def coletar(db, desde):
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    jobs = defaultdict(list)
    for r in c.execute("SELECT id, tarefa, erro, terminado_em FROM jobs WHERE status = 'failed'"):
        if seg(r['terminado_em']) >= desde:
            jobs[(r['tarefa'], normalizar(r['erro']))].append(r['id'])
    fases = defaultdict(list)
    for r in c.execute("""
        SELECT fl.tipo, fl.prefixo, fl.id, f.fase, f.alvo, f.erro, j.terminado_em
          FROM fluxo_fases f JOIN fluxos fl ON fl.id = f.fluxo_id
          LEFT JOIN jobs j ON j.id = f.job_id
         WHERE f.estado = 'falhou'"""):
        if seg(r['terminado_em']) >= desde:
            fases[(r['tipo'], r['fase'], normalizar(r['erro']))].append(f"{r['prefixo']}#{r['id']}")
    aval = defaultdict(lambda: {'aprovar': 0, 'notas': [], 'refazer': 0, 'responder': 0, 'motivos': []})
    tem_tabela = c.execute("SELECT 1 FROM sqlite_master WHERE name = 'avaliacoes'").fetchone()
    if tem_tabela:
        for r in c.execute('SELECT * FROM avaliacoes ORDER BY id'):
            if seg(r['criado_em']) < desde:
                continue
            a = aval[(r['tipo'], r['fase'])]
            a[r['acao']] += 1
            if r['nota'] is not None:
                a['notas'].append(r['nota'])
            if r['motivo']:
                quem = r['palavra'] or r['acao']
                a['motivos'].append(f"{r['prefixo']}#{r['fluxo_id']} {quem}: {r['motivo'][:160]}")
    return jobs, fases, aval, bool(tem_tabela)


def sil(*args):
    r = subprocess.run([sys.executable, str(SIL), '--project', str(RAIZ), *args], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'sil {args[0]} falhou: {r.stderr.strip() or r.stdout.strip()}')
    return json.loads(r.stdout)


def ler(p, padrao):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return padrao


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dias', type=int, default=7)
    ap.add_argument('--minimo', type=int, default=2, help='repetições para virar ocorrência (padrão 2)')
    ap.add_argument('--db', default=str(RAIZ / 'inemaccbot.db'))
    ap.add_argument('--sem-sil', action='store_true')
    ap.add_argument('--visto', action='store_true')
    a = ap.parse_args()

    if a.visto:
        NOVAS.write_text(json.dumps({'novas': [], 'visto_em': datetime.date.today().isoformat()}))
        print('ocorrências novas marcadas como vistas'); return

    hoje = datetime.date.today().isoformat()
    jobs, fases, aval, tem_aval = coletar(a.db, time.time() - a.dias * 86400)
    usar_sil = not a.sem_sil and (RAIZ / '.sil').is_dir() and SIL.is_file()
    visto = ler(VISTO, {})
    novas = ler(NOVAS, {}).get('novas', [])
    criadas = []

    def registrar(assinatura, titulo, evidencia):
        if assinatura in visto:
            visto[assinatura]['vezes'] += 1
            return f" (já registrada: {visto[assinatura]['id']})"
        if not usar_sil:
            return ''
        o = sil('occurrence', '--title', titulo[:200], '--evidence', evidencia[:900],
                '--cause', 'A investigar (coletor LOOP-R)')
        visto[assinatura] = {'id': o['id'], 'primeira': hoje, 'vezes': 1}
        criadas.append(o['id'])
        return f" → **{o['id']} nova**"

    L = [f'# LOOP-R inemaccbot — {hoje} (últimos {a.dias} dias)', '']
    L += ['## Jobs que falharam', '']
    for (tarefa, erro), ids in sorted(jobs.items(), key=lambda x: -len(x[1])):
        marca = ''
        if len(ids) >= a.minimo:
            marca = registrar(f'job|{tarefa}|{erro}', f'{tarefa}: {erro} ({len(ids)}× em {a.dias} dias)',
                              f'jobs failed {len(ids)}× desde {a.dias} dias; ids {ids[:12]}')
        L.append(f'- **{len(ids)}×** `{tarefa}` — {erro}{marca}')
    if not jobs:
        L.append('- nenhum')
    L += ['', '## Fases de fluxo que falharam', '']
    for (tipo, fase, erro), refs in sorted(fases.items(), key=lambda x: -len(x[1])):
        marca = ''
        if len(refs) >= a.minimo:
            marca = registrar(f'fase|{tipo}|{fase}|{erro}', f'{tipo}/{fase}: {erro} ({len(refs)}× em {a.dias} dias)',
                              f'fases falhou {len(refs)}×; fluxos {refs[:12]}')
        L.append(f'- **{len(refs)}×** `{tipo}/{fase}` — {erro}{marca}')
    if not fases:
        L.append('- nenhuma')
    L += ['', '## O que o dono disse no portão', '']
    if not tem_aval:
        L.append('- tabela `avaliacoes` ainda não existe (bot sem a migration 5)')
    for (tipo, fase), v in sorted(aval.items()):
        media = f"{sum(v['notas']) / len(v['notas']):.1f} ({len(v['notas'])} notas)" if v['notas'] else 'sem nota'
        reprov = v['refazer'] + v['responder']
        marca = ''
        if reprov >= a.minimo:
            marca = registrar(f'aval|{tipo}|{fase}|{hoje[:7]}',
                              f'{tipo}/{fase}: {reprov} refazer/reprova em {a.dias} dias',
                              ' | '.join(v['motivos'][:6]) or 'sem motivo escrito')
        L.append(f"- `{tipo}/{fase}`: {v['aprovar']} aprovação(ões), nota média {media}, "
                 f"{v['refazer']} refazer, {v['responder']} resposta(s) ao portão{marca}")
        L += [f'  - {m}' for m in v['motivos'][:8]]
    if tem_aval and not aval:
        L.append('- nenhuma avaliação na janela')

    pasta = RAIZ / 'state/loopr'
    pasta.mkdir(parents=True, exist_ok=True)
    rel = pasta / f'{hoje}.md'
    rel.write_text('\n'.join(L) + '\n')
    if usar_sil:
        VISTO.write_text(json.dumps(visto, ensure_ascii=False, indent=1))
        NOVAS.write_text(json.dumps({'novas': novas + criadas, 'relatorio': str(rel)}, ensure_ascii=False))
    print(json.dumps({'relatorio': str(rel), 'grupos_jobs': len(jobs), 'grupos_fases': len(fases),
                      'tipos_avaliados': len(aval), 'ocorrencias_novas': criadas}, ensure_ascii=False))


if __name__ == '__main__':
    main()
