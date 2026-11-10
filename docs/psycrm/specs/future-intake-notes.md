# Futuro (B11): nota de primera sesión (intake)

**Estado:** idea con spec, **no construida**. Post-MVP.

## Visión

La primera sesión de un cliente no es una sesión más. La terapeuta necesita una **evaluación inicial** que sirva de base para el plan de tratamiento (B1), para la evaluación de riesgo de todas las sesiones siguientes y para cualquier revisión del expediente. Hoy las notas de sesión (días 3 y 4) tienen un solo formato. Este feature agrega una **variante de nota para la primera sesión**, escrita por la terapeuta, que reutiliza todo lo ya construido: el bloqueo de 72 h, las revisiones, los anexos, la evaluación de riesgo obligatoria y el MSE.

## Qué ya existe y se reutiliza

| Pieza | Dónde está | Cómo se usa aquí |
|---|---|---|
| Tipo de sesión `intake` | `session_notes.session_type` (día 3) | Activa la variante. Ya está en la lista de tipos |
| Evaluación de riesgo obligatoria | Día 3, `validateRiskForSign` | Igual. Ninguna nota de intake se firma sin riesgo |
| Vocabulario MSE y de riesgo | `server/lib/clinical-vocab.ts` (día 3) | Igual |
| Bloqueo a 72 h, revisiones, anexos | Día 3 (triggers de Postgres) | Igual. Sin cambios |
| `diagnosis_codes` | Día 3 | Se usa para la impresión diagnóstica |
| Cuestionario de admisión | Días 5 y 6 (llenado por el cliente) | **No se duplica.** La nota de intake lo muestra en solo lectura y referencia sus respuestas |
| Documentos firmados (consentimiento, privacidad, telesalud, asentimiento del menor) | Días 5 y 6 (`signed_documents`) | La nota verifica que estén firmados antes de firmarse |
| Auditoría | Día 2 | Igual, más los eventos nuevos (ver abajo) |

**Distinción importante:** el cuestionario de admisión lo escribe el **cliente** y es un documento para firmar. La nota de intake la escribe la **terapeuta** y es parte del expediente clínico.

## Cuándo se usa la variante

- Se usa cuando `session_type = 'intake'`.
- Al crear una nota desde una cita, si el cliente **no tiene ninguna nota firmada ni borrador de tipo `intake`**, el tipo se propone como `intake`. La terapeuta puede cambiarlo.
- Solo puede haber **una nota de intake activa por cliente** (no borrada). Índice único parcial:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS session_notes_one_intake
  ON session_notes (contact_id)
  WHERE session_type = 'intake' AND deleted_at IS NULL;
```

Si la nota de intake se borra dentro de las 72 h, se puede crear otra.

## Modelo de datos

Se agrega **una columna** a `session_notes`, en lugar de una tabla nueva. Así la nota de intake hereda sin cambios el bloqueo, las revisiones y los anexos.

```sql
ALTER TABLE session_notes ADD COLUMN IF NOT EXISTS intake jsonb NOT NULL DEFAULT '{}';

-- Una nota de intake firmada debe tener las secciones obligatorias.
ALTER TABLE session_notes DROP CONSTRAINT IF EXISTS intake_required_to_sign;
ALTER TABLE session_notes ADD CONSTRAINT intake_required_to_sign CHECK (
  session_type <> 'intake' OR status = 'draft' OR (
    intake ? 'presenting_problem' AND
    intake ? 'consents' AND
    intake ? 'formulation' AND
    intake ? 'treatment_plan'
  )
);
```

La validación de cada sección se hace con Zod en la API (igual que el riesgo). El CHECK es la red de seguridad.

## Secciones de la nota

Wizard de **7 pasos** en inglés (la UI de la terapeuta sigue la convención del proyecto). El autoguardado, el `LockBadge` y el stepper son los del día 4.

### 1. Context and sources
- Cliente, cita, fecha, duración, modalidad (precargados desde la cita).
- **Fuentes de información:** cliente, tutor/padre, referido (quién), registros médicos, otro.
- Personas presentes (tutor en menores).

### 2. Consents and disclosures
Checklist con estado **leído desde los documentos firmados** (días 5 y 6), no autodeclarado:
- Consentimiento informado: firmado / pendiente (con fecha).
- Aviso de privacidad: firmado / pendiente.
- Consentimiento de telesalud: firmado / no aplica.
- Asentimiento del menor y consentimiento del tutor: firmado / no aplica (solo paquete de menor).
- **Límites de la confidencialidad revisados** (checkbox obligatorio): incluye deber de reportar, riesgo a terceros y las excepciones de la ley aplicable.
- Si falta un documento obligatorio, la nota puede guardarse en borrador pero **no firmarse**.

### 3. Presenting problem and history
- **Motivo de consulta**, en las palabras del cliente (texto).
- **Inicio, duración, frecuencia y severidad** de los síntomas principales (campos cortos).
- **Factores desencadenantes y de mantenimiento** (texto).
- **Tratamiento previo** de salud mental: tipo, fechas, respuesta (lista repetible).
- **Hospitalizaciones y intentos previos** (lista repetible con fechas; alimenta los factores de riesgo del paso 5).
- **Historia médica:** condiciones, medicamentos actuales (lista), alergias.
- **Historia social:** vivienda, empleo o escuela, red de apoyo, relaciones.
- **Historia familiar** de salud mental y suicidio.
- **Trauma y abuso:** texto libre con indicador de si se revisó.
- **Consumo de sustancias:** texto libre, con un campo opcional para un instrumento de cribado (AUDIT-C / DAST-10, ver A2).
- **Respuestas del cuestionario de admisión:** bloque de solo lectura con un enlace al documento firmado. La terapeuta puede citar una respuesta en su texto, no copiarla.

### 4. Mental status
- Reutiliza el MSE del día 3 (`MSE_DOMAINS`) y el ánimo 1–10.
- Opción de comparar con el cuadro del cliente en el texto de historia.

### 5. Risk assessment (obligatorio)
- Reutiliza **exactamente** el paso de riesgo del día 4: ideación suicida, autolesión, daño a otros, factores, protectores, acciones y nivel global, con las mismas reglas de validación.
- Se agrega una pregunta: **"¿Qué se revisó en el historial de intentos y hospitalizaciones?"** (texto, obligatorio si hay intentos previos en el paso 3).
- El riesgo de la primera sesión **es el punto de partida** de la bandera del expediente (día 4, sección 5).

### 6. Formulation and diagnostic impression
- **Formulación biopsicosocial:** predisponentes, precipitantes, perpetuantes y protectores (cuatro campos de texto).
- **Impresión diagnóstica:** códigos DSM-5-TR o ICD-10-CM (lista con búsqueda; ver pregunta abierta 3).
- Cada diagnóstico se marca como **provisional** o **confirmado**, y se pueden agregar **diagnósticos descartados** (rule-outs).
- Campo de **diagnóstico diferencial** (texto).

### 7. Initial plan and goals
- **Plan inicial:** frecuencia de sesiones, modalidad, duración estimada del tratamiento (texto).
- **Metas del cliente**, en sus palabras (lista repetible). Son la entrada del **plan de tratamiento (B1)**, que se crea después de la primera sesión y no en esta nota.
- **Referidos:** médico, psiquiatría, grupo de apoyo, otro (lista con motivo).
- **Coordinación de cuidados:** solo registro, sin envíos (las divulgaciones van en B3).
- **Revisar y firmar:** vista previa en formato de reporte. Se bloquea la firma si falta un paso obligatorio. Al firmar, se crea el evento de intake.

## Reporte imprimible

- Membrete de la práctica, "CONFIDENCIAL – Información de salud protegida", datos del cliente, datos de la sesión.
- Secciones en el mismo orden del wizard. La sección de riesgo siempre aparece, igual que en el reporte de notas.
- Lista de consentimientos con fechas de firma.
- Pie con el id de la nota y el hash de contenido.
- Se imprime con `window.print()` (MVP). El PDF del expediente completo es B8.

## Efectos fuera de la nota

- **Expediente del cliente:** muestra "Intake completed (fecha)" o "Intake pending" en el encabezado.
- **Evento de workflow `intake_note_signed`** (se emite al firmar; lo consume el runner del día 7). Uso sugerido en el onboarding sembrado: mover de "Primera cita agendada" a "Cliente activo" y crear la tarea "Crear plan de tratamiento".
- **Tarea automática:** si una primera cita se completa y no tiene nota de intake firmada en 24 h, se crea una tarea "Firmar nota de intake" para la terapeuta.
- **Auditoría:**
  - `intake.started` (al crear la nota de tipo intake);
  - `intake.signed`;
  - Los cambios de cualquier sección usan la auditoría de notas (`note.updated` con diff por campo, sin el contenido clínico completo).

## Relación con otros features

| Feature | Relación |
|---|---|
| **B1 Plan de tratamiento** | La nota de intake aporta las metas iniciales y la formulación. B1 es el documento vivo que se revisa cada 90 días |
| **A2 Instrumentos** | Los cribados (PHQ-9, GAD-7, AUDIT-C) se pueden capturar en la nota de intake y guardar como resultados de línea base |
| **B3 Autorizaciones de divulgación** | Los referidos y la coordinación de cuidados pueden requerir una autorización (ROI) antes de enviar información |
| **B8 Exportación del expediente** | La nota de intake es la primera hoja del expediente exportado |
| **Día 6 (firma pública)** | Provee los documentos de consentimiento y el estado de firma que muestra el paso 2 |

## Criterios de aceptación

1. Crear una nota desde la primera cita propone el tipo `intake` si el cliente no tiene notas previas, y la terapeuta puede cambiarlo.
2. Solo hay una nota de intake activa por cliente. Un segundo intento devuelve 409 con un mensaje claro.
3. Una nota de intake no se puede firmar sin: motivo de consulta, consentimientos verificados, formulación, plan inicial y riesgo completo. Los campos faltantes se señalan en el paso correspondiente.
4. Con intentos previos registrados en el paso 3, la pregunta de revisión del paso 5 es obligatoria.
5. El estado de los consentimientos del paso 2 viene de `signed_documents`. Un documento no firmado no se puede marcar como firmado a mano.
6. Al firmar, se emite `intake_note_signed` y se escribe `intake.signed` en la auditoría, en la misma transacción.
7. Después de 72 h la nota queda bloqueada igual que cualquier nota: la base de datos rechaza cambios, y la nota se corrige con anexos.
8. El reporte imprimible incluye todas las secciones, con la sección de riesgo siempre presente.
9. El borrado solo es posible dentro de las 72 h (día 3). Un intake borrado en ese plazo permite crear uno nuevo. Después de 72 h no se borra: la corrección se hace con anexos.

## Pruebas

- **Zod:** validación de cada sección; reglas de intentos previos → revisión obligatoria.
- **PGlite:** el índice único parcial, el CHECK `intake_required_to_sign` y el bloqueo a 72 h con `intake` (igual que el de notas).
- **Rutas:** 409 con segundo intake; firma sin consentimientos; firma con consentimientos de `signed_documents`.
- **UI:** recorrido de los 7 pasos con capturas (`npm run shoot`) y revisión del reporte en modo impresión.

## Preguntas abiertas (decidir antes de construir)

1. **¿La nota de intake es obligatoria antes de la segunda sesión?** Si sí, el sistema puede bloquear la creación de una segunda nota hasta firmar la de intake. Recomendación: sí, con aviso y excepción justificada, no bloqueo duro.
2. **¿Quién puede firmar?** Solo la terapeuta con licencia, o también un/a practicante supervisado (ver B9, co-firma)?
3. **Sistema de codificación:** DSM-5-TR (texto y código), ICD-10-CM (lo que piden las aseguradoras) o ambos? Recomendación: ambos, con DSM-5-TR como base y el ICD-10-CM mapeado.
4. **Menores:** ¿la historia familiar y la escolar tienen secciones fijas para el paquete de adolescentes? Recomendación: sí, con la fuente marcada como tutor o menor.
5. **Cribados:** ¿se capturan en esta nota o se esperan a A2?
6. **Ley aplicable:** los límites de confidencialidad y el deber de reportar en Puerto Rico (ver `PLAN_MVP.md` §6, decisión 1) deben validarse con el asesor legal antes de usar el texto del paso 2.

## Esfuerzo estimado

≈ 3 días: 1 día de modelo, validación y reglas (columna, índice, CHECK, Zod y tests); 1.5 días de wizard, reporte y consentimientos; 0.5 día de eventos de workflow y tarea automática. Requiere los días 3–7 terminados.
