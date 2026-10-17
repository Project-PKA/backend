# Política de segurança

## Reportando uma vulnerabilidade

**Não abra issue pública.** Use
[Security → Report a vulnerability](../../security/advisories/new) (GitHub
Security Advisories, privado) ou o canal privado do time de plataforma.

Inclua os passos para reproduzir, o impacto estimado e a versão/commit e o
ambiente afetados. Tempo de primeira resposta: <!-- ex.: 2 dias úteis -->.

## Versões suportadas

Só a última versão publicada (tag `vX.Y.Z` mais recente) recebe correção.
<!-- Ajuste se o projeto mantiver mais de uma linha de versão. -->

## O que a fundação já cobre

| Camada | Onde |
| --- | --- |
| SAST (injeção, SSRF, desserialização) | `codeql.yml` |
| Dependências e imagem base vulneráveis | Dependabot + alerts |
| Segredo commitado | Secret scanning + push protection (`SETUP-GITHUB.md` A4) |
| `.env` dentro da imagem | `.dockerignore` |
| Qualidade e hotspots de segurança | SonarCloud, dentro do `ci-success` |
| Credencial de deploy | OIDC por Environment, com aprovação em `homolog`/`prod` |
| Revisão humana | Checklist abaixo, cobrado no template de PR |

## Checklist OWASP Top 10

Use ao revisar qualquer mudança que toque autenticação, dados sensíveis ou
entrada externa (o template de PR já cobra):

1. **Broken Access Control:** autorização verificada em todo endpoint novo
   ou alterado; sem acesso a recurso de outro usuário por troca de ID (IDOR).
2. **Cryptographic Failures:** TLS em trânsito; dado sensível criptografado em
   repouso quando aplicável; senha com hash forte (argon2/bcrypt); nenhum
   segredo em log ou código.
3. **Injection:** toda entrada externa validada; SQL só parametrizado ou via
   ORM; nada de comando de sistema montado com entrada.
4. **Insecure Design:** limite de payload, rate limiting e timeouts desde o
   desenho; mensagem de erro não revela se a conta existe.
5. **Security Misconfiguration:** CORS restritivo, headers de segurança,
   sem debug/stack trace em produção, permissões padrão fechadas.
6. **Vulnerable and Outdated Components:** Dependabot limpo; dependência nova
   passa pela aprovação humana (`AGENTS.md`, seção 6).
7. **Identification and Authentication Failures:** sessão e tokens seguem o
   `ARCHITECTURE.md` (seção 6); expiração e revogação funcionam.
8. **Software and Data Integrity Failures:** webhook com assinatura
   verificada; imagem só a construída pelo CI (build once).
9. **Security Logging and Monitoring Failures:** login, falha de autorização
   e mudança de permissão logados de forma estruturada, sem dado sensível.
10. **SSRF:** nenhuma requisição a URL/host vindo de entrada externa sem
    allowlist.

## Gestão de secrets

Ver `ARCHITECTURE.md`, seção 7.
