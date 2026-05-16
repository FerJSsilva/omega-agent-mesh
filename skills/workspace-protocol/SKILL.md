---
name: workspace-protocol
description: "Ensina agents a criar artefatos no workspace compartilhado seguindo o padrão de frontmatter."
version: "1.0.0"
---

# Workspace Protocol

O workspace é uma pasta compartilhada onde todos os agents salvam seus artefatos. Cada artefato é um arquivo `.md` com frontmatter YAML.

## Onde salvar

O caminho do workspace é passado no seu prompt como `Workspace: /caminho/absoluto`. Use esse caminho.

## Padrão de nome do arquivo

```
<tipo>-<numero>-<slug>.md
```

Exemplos:
- `ideia-001-futuro-ia.md`
- `texto-001-futuro-ia.md`
- `revisao-001-futuro-ia.md`
- `publicacao-001-futuro-ia.md`

## Frontmatter obrigatório

```yaml
---
id: <tipo>-<numero>-<slug>
type: <tipo>
status: PRONTO
created: <ISO timestamp>
lastEdited: <ISO timestamp>
---
```

## Campos adicionais por tipo

### type: ideia
```yaml
tema: "o tema original"
```

### type: texto
```yaml
ideia: <id da ideia de origem>
palavras: <contagem de palavras>
```

### type: revisao
```yaml
texto: <id do texto revisado>
mudancas: <número de mudanças feitas>
```

### type: publicacao
```yaml
revisao: <id da revisão>
titulo: "título final"
```

## Exemplo completo

```markdown
---
id: ideia-001-futuro-ia
type: ideia
status: PRONTO
tema: "o futuro da inteligência artificial"
created: 2026-05-09T14:00:00Z
lastEdited: 2026-05-09T14:00:00Z
---

# O Futuro da IA

A inteligência artificial está transformando...
```

## Regra importante

Sempre use o caminho **absoluto** do arquivo que você criou quando passar pro próximo agent. O próximo agent precisa do path completo para ler.
