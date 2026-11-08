# Resultados del día 7: automatización del pipeline de onboarding

Spec: [`specs/day-07-onboarding-automation.md`](specs/day-07-onboarding-automation.md).

## Qué se construyó
- **Motor**: los eventos llevan `payload` y `depth`; el despachador filtra cada workflow por su configuración (`matchesTriggerConfig`) y **corta las cadenas** a profundidad 3 con `workflow.loop_prevented`. Una corrida tiene id determinista por evento y workflow, así que un reintento de pg-boss la retoma sin repetir pasos. Un paso `failed` detiene la corrida.
- **Acciones nuevas**: `move_to_stage` (solo hacia adelante por defecto, crea la tarjeta si falta, usa la misma función que el tablero), `send_document_packet` (mismas reglas que el botón del operador; nunca envía el paquete adulto a un menor ni a alguien sin fecha de nacimiento, y deja una tarea), `create_task` (sin duplicar) y **`send_email` real**, que falla de verdad si no hay proveedor.
- **Triggers con payload**: `documents_completed`, `document_signed`, `appointment_checked_in`, `session_note_signed` (`isFirst`), `pipeline_stage_changed` (origen operador/workflow), `appointment_booked`, y `contact_created` ahora también desde "Add contact" y la reserva pública.
- **Workflows sembrados** (W1–W4): *new client* → tarjeta en "New contact", paquete enviado, tarjeta en "Documents sent"; *documents signed* → "Documents signed" y la tarea "Schedule first appointment with …"; *first appointment* → "First appointment booked"; *active client* → "Active client" con la primera nota firmada. Quedan en borrador hasta que los documentos estén en vigor.
- **UI (inglés)**: "Send onboarding packet now" en Add contact, pasos y filtros nuevos en Automations, y "Moved by workflow / by Dra. X · 2h ago" en cada tarjeta del tablero.

## Verificación
- `npm run typecheck` limpio; `npx vitest run`: **212 archivos, 1874 pruebas**.
- Integración con base real (`onboarding-flow.test.ts`): el cliente recorre todo el embudo con el actor `workflow` en el audit; una tarjeta que ella movió más adelante no retrocede; un menor o un cliente sin fecha de nacimiento no recibe el paquete adulto y queda una tarea; "no enviar" no arranca nada; sin proveedor de correo el paso falla y la tarjeta no dice "Documents sent"; un reintento no duplica paquete, tarea ni corrida; una corrida interrumpida continúa; los filtros funcionan; un ciclo se corta a profundidad 3; el seed es idempotente y respeta lo que ella edite.
- Navegador: agregar un contacto envía el paquete y mueve la tarjeta; el tablero y las corridas lo reflejan.

## Pendientes y advertencias
Ver "Estado de implementación (día 7)" en el spec. Lo más importante: **sin un proveedor de correo con BAA, nada de esto debe usarse con clientes reales**, las esperas siguen en memoria, y `PUBLIC_BASE_URL` debe estar configurada.

> **Después del día 7:** `send_document_packet` acepta `adolescentPacketId` (paquete adolescente al tutor) para la [invitación al cliente](RESULTADOS_INVITACION.md); el workflow W1 sembrado lo trae.
