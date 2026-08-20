# Manifestos de integração

Um arquivo por repo plugado: `<nome>.json`, no esquema de `src/dominio/manifesto.ts`.

**Quem escreve:** o `scripts/gerar-manifesto.sh`, numa máquina com modelo, uma vez
por repo — ele lê o repo, propõe os parâmetros e você revisa.

**Quem lê:** o `scripts/plugar-repo.sh`, em qualquer máquina, sem modelo nenhum.
Por isso os manifestos são versionados: numa VPS nova, `git pull` + plugar bastam,
e o resultado é o mesmo de todas as outras.

Nunca ponha segredo aqui. `requer.chaves` declara o NOME da variável; o valor mora
no cofre (`~/projetos/wifi/.env`), e o `origin` deste repo é público.

Passo a passo manual (quando o script não serve): `docs/instalar-analisevideo.md`.
