# Resultados del día 6: firma pública de documentos

Spec: [`specs/day-06-public-signing.md`](specs/day-06-public-signing.md).

## Qué se construyó
- **Esquema**: `document_requests` (congela las versiones exactas), `document_signers` (solo guarda `sha256(token)`, el código y los intentos) y `signed_documents`, que es **inmutable** (UPDATE, DELETE y TRUNCATE rechazados; `esign_consent` siempre verdadero; un documento por firmante).
- **Envío (operador)**: el paquete debe calzar con la edad (18+ adulto, menor de 18 adolescente; sin fecha de nacimiento no se envía), solo se envían versiones en vigor, se pueden excluir documentos, los firmantes se validan por audiencia y rol, y el correo (español, sin PHI) lleva solo el nombre de la práctica y el enlace. Reenviar, anular (el motivo no va al audit), aceptar una retención y vencimiento con tarea de seguimiento.
- **Página pública `/d/:token`** (servidor, móvil primero, CSP con nonce): verificación por código de 6 dígitos (10 min, 5 intentos, límites por firmante e IP), lista de documentos, un documento por pantalla con campos condicionales, firma dibujada con el dedo, guardar y continuar después, documento ya firmado en solo lectura, pantalla final y copia imprimible (válida 30 días).
- **Cada firma**: HTML exacto con bloque de evidencia (nombre, fecha AST, IP, correo enmascarado, id), su SHA-256, IP y agente, consentimiento, auditoría con actor `client` y evento en la línea de tiempo del cliente. Al terminar todo: `packet.completed`, `documents_completed` (una vez), traspaso de respuestas al contacto y correo de copia.
- **UI del operador (inglés)**: pestaña de Documentos en el cliente (diálogo de envío con paquete preseleccionado por edad, tarjetas por solicitud con progreso por firmante y documento, lista de firmados), visor sellado con "record intact", y Documents → **Sent** con filtros.

## Verificación
- `npm run typecheck` limpio; `npx vitest run`: **210 archivos, 1852 pruebas**.
- Pruebas con base real (PGlite): inmutabilidad y restricciones, el flujo completo de firma, hash recalculado, idempotencia, los 422/403/413, código (bloqueo, vencimiento, sesión de 60 min, límite de tasa), retención por fecha de nacimiento, paquete de menor con tutor y menor, vencimiento, módulo apagado, enlace de copia a 29 y 31 días, y que el token nunca se guarda en claro.
- Navegador (Playwright, iPhone SE 375 px): enviar, verificar (con código incorrecto y correcto), firmar los 6 documentos con firma dibujada, descargar la copia, y abrir el documento firmado como operador. Sin scroll horizontal ni errores de página.

## Pendientes y advertencias
Ver "Estado de implementación (día 6)" en el spec. Lo más importante: **no hay adaptador de correo con BAA** (SES) todavía, así que el flujo no debe usarse con clientes reales hasta tenerlo.
