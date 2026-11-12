# Futuro (B11): nota de entrevista inicial (intake)

**Estado:** spec revisada con la terapeuta el 12 de noviembre de 2026, **no construida**. Post-MVP.

## Visión

Hoy la entrevista inicial se toma a mano, en un impreso de 5 páginas ("Nota de Entrevista Inicial", con su membrete). Este feature pasa **ese mismo formulario** a la app, como una variante de la nota de sesión. La regla de diseño es que se sienta como su papel: **sus secciones, en su orden y con sus palabras**. Solo se añade lo que el sistema necesita (riesgo estructurado, diagnóstico para cobrar, datos de telesalud) y el examen del estado mental, que ella pidió.

Reemplaza la versión anterior de esta spec, que era un modelo genérico de 7 pasos (formulación biopsicosocial, fuentes, diagnósticos descartados, referidos, evento de automatización). Todo eso se quitó porque no es parte de su forma de trabajar.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Estructura | La de su formulario, sección por sección |
| Idioma | **Español**: etiquetas de la nota, opciones del examen del estado mental y el reporte impreso. La versión en inglés queda pendiente (fase C, bilingüe) |
| Examen del estado mental | **Se incluye**, después del historial personal. **No es obligatorio** para firmar |
| Diagnóstico ICD-10 | **Se incluye y es opcional**. Si falta, el cargo de la evaluación se puede crear igual, pero la superbill pedirá el diagnóstico (eso ya funciona así) |
| Funcionamiento actual | Cada área guarda **un texto que mezcla el dato y cómo se ha afectado** (por ejemplo, el nombre de la escuela y el impacto). La casilla marca el área como **afectada** |
| Riesgo | La evaluación estructurada que ya exige toda nota sigue siendo obligatoria. Su texto de "Peligrosidad" es la narrativa de ese paso |

## Qué ya existe y se reutiliza

| Pieza | Cómo se usa aquí |
|---|---|
| `session_notes` con `session_type = 'intake'` | La nota de intake es una nota más: hereda el autoguardado, la firma, el bloqueo a las 72 horas, las revisiones y los anexos |
| Evaluación de riesgo (`risk_*`) y el chip de riesgo de la ficha | Igual. El riesgo de la primera sesión es el punto de partida del chip |
| Examen del estado mental (`mse`, `mood_rating`) | Las mismas 11 áreas y la escala de ánimo, con las opciones traducidas |
| `diagnosis_codes` | El diagnóstico opcional |
| Cuestionario de admisión del cliente (días 5 y 6) | Se muestra al lado de cada sección para aprovechar lo que el cliente ya contestó (ver abajo) |
| Logo de la práctica (Settings → Branding) | Membrete del reporte impreso |
| Billing: sugerencias "Ready to bill" | Una nota de intake firmada ya sugiere el código 90791 con el precio de evaluación y su diagnóstico |

## Secciones (en el orden de su formulario)

| # | Sección | Campos |
|---|---|---|
| 1 | **Datos de la sesión** | Cliente, fecha, hora, duración y modalidad (de la cita). Si la modalidad es video o teléfono: **ubicación física del cliente**, si está en Puerto Rico y si está en un lugar privado (los mismos campos que usará la telesalud, B5) |
| 2 | **Queja / problema que presenta** | Texto. Ayuda: "Estresores actuales" |
| 3 | **Historial del problema** | Texto. Ayuda: "Factores precipitantes y/o exacerbantes · Síntomas: duración, severidad, frecuencia" |
| 4 | **Funcionamiento actual (por áreas)** | 8 renglones con casilla ("afectada") y texto: Ocupacional, Familiar, Social, Sueño, Energía, Apetito, Hobbies / recreacional, Salud física |
| 5 | **Historial de salud mental** | 5 renglones con casilla y texto: Psiquiátrico, Psicológico, Hospitalizaciones, Medicamentos (pasados / actuales), Diagnósticos. **Es la sección que ella más llena** y en el papel no le cabe: aquí **cada renglón es un área de texto completa**, a lo ancho, que crece mientras escribe, en vez del renglón de una línea de la hoja. Al marcar la casilla, el área se abre |
| 6 | **Historial familiar de salud mental** | Texto. Ayuda: "Diagnóstico · Tratamiento · Sustancias" |
| 7 | **Historial de salud física** | Dos textos: Personal y Familiar |
| 8 | **Historial personal** | 7 renglones con casilla y texto: Relaciones con la familia de origen, Eventos / problemas en la niñez, Problemas académicos o conductuales en la escuela, Espiritualidad / fe, Historial de relaciones románticas, Historial de relaciones sociales, Historial de uso de sustancias |
| 9 | **Estado mental** | Las 11 áreas (apariencia, conducta, habla, ánimo observado, afecto, proceso y contenido del pensamiento, percepción, cognición, introspección, juicio), cada una con opciones y nota libre; ánimo reportado y escala 1–10. Opcional |
| 10 | **Peligrosidad** | Su texto ("Historial y actual · Manejo en caso de crisis") más la evaluación de riesgo estructurada de siempre (obligatoria) |
| 11 | **Factores protectivos** | Su texto ("Fortalezas · Destrezas de afrontamiento · Hobbies · Red de apoyo") más la lista de factores protectores de siempre |
| 12 | **Metas y objetivos del tratamiento** | Dos textos: Corto plazo (3 meses) y Largo plazo (6 meses). Serán la entrada del plan de tratamiento (B1) |
| 13 | **Expectativas, temores o preguntas acerca del proceso** | Texto |
| 14 | **Impresión diagnóstica** | Códigos ICD-10-CM, opcional |
| 15 | **Revisar y firmar** | Vista previa igual al reporte impreso; firma con la firma de notas de siempre |

**El espacio no lo limita la hoja.** En la app ningún campo tiene el tamaño de la casilla del papel: todo texto crece con lo que se escribe (hasta 20.000 caracteres por campo, como las notas de sesión). En el reporte impreso cada texto ocupa lo que necesita y la sección sigue en la página siguiente si hace falta. Los renglones con casilla (secciones 4, 5 y 8) muestran el texto debajo de la etiqueta, a todo lo ancho, y no al lado como en la hoja.

En pantalla, las secciones se agrupan en pasos del asistente (por ejemplo: sesión y problema · funcionamiento · historiales · estado mental · riesgo y factores protectivos · metas y diagnóstico · revisar y firmar). El orden de las secciones no cambia.

## Aprovechar el cuestionario de admisión

El cliente ya contestó el "Cuestionario de admisión" antes de la primera cita. Junto a cada sección, la nota muestra la respuesta del cliente, en solo lectura, con un botón **"Usar respuesta del cliente"**. El botón la inserta en el texto como cita y ella la edita a partir de ahí.

| Pregunta del cuestionario | Sección de la nota |
|---|---|
| ¿Qué lo/la trae a terapia en este momento? | Queja / problema |
| Tratamiento de salud mental previo (detalle) | Historial de salud mental → Psicológico |
| Medicamentos y dosis | Historial de salud mental → Medicamentos |
| Condiciones de salud física importantes | Historial de salud física → Personal |
| Historial de salud mental en la familia | Historial familiar de salud mental |
| Consumo de alcohol u otras sustancias | Historial personal → Uso de sustancias |
| Personas que lo/la apoyan | Factores protectivos |
| ¿Qué espera lograr con la terapia? | Expectativas |

Si el cliente no ha contestado el cuestionario, esa columna no aparece.

## Reglas

- **Una sola nota de intake viva por cliente** (índice único parcial sobre `contact_id` cuando `session_type = 'intake'` y no está borrada). Un segundo intento responde 409 con un mensaje claro. Si se borra dentro de las 72 horas, se puede crear otra.
- **Al crear una nota** desde una cita de un cliente sin notas, el tipo se propone como `intake`. Ella lo puede cambiar.
- **Para firmar** hace falta: la queja / problema que presenta y la evaluación de riesgo completa. Todo lo demás es opcional, incluidos el estado mental y el diagnóstico.
- **Consentimientos:** si el cliente no ha firmado el consentimiento informado, la nota muestra un **aviso**. No bloquea la firma.
- Después de las 72 horas la nota queda bloqueada igual que cualquier otra y se corrige con anexos.

## Modelo de datos

Una columna nueva en `session_notes`, sin tabla aparte, para heredar el bloqueo, las revisiones y los anexos:

```sql
ALTER TABLE session_notes ADD COLUMN IF NOT EXISTS intake jsonb NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS session_notes_one_intake
  ON session_notes (location_id, contact_id)
  WHERE session_type = 'intake' AND deleted_at IS NULL;
```

`intake` guarda las secciones 1 a 8 y 10 a 13 en claves fijas (por ejemplo `presenting_problem`, `problem_history`, `functioning.occupational = { affected, text }`, `telehealth = { location, in_pr, private }`). El estado mental, el riesgo y el diagnóstico usan las columnas que ya existen. La validación es con Zod en la API (textos con límite, claves cerradas). La auditoría de cambios registra **nombres de campo**, nunca el texto clínico, como en las demás notas.

## Fuera de la nota

- **Ficha del cliente:** chip **"Intake pendiente"** junto a los de riesgo y saldo mientras no haya una nota de intake firmada; desaparece al firmarla.
- **Billing:** sin cambios. La sesión firmada aparece en "Ready to bill" con 90791 y el precio de evaluación.
- **Reporte impreso:** en español, con su logo y su nombre, "Confidencial — Información de salud protegida", las secciones en el mismo orden y una sola columna. Los renglones vacíos no se imprimen.

## Pruebas

- **PGlite:** el índice de un intake por cliente, el 409, la firma sin queja o sin riesgo, el bloqueo a las 72 horas con la columna nueva, y que la auditoría no lleva texto clínico.
- **Zod:** claves cerradas y límites de texto.
- **Web:** que las etiquetas de las secciones coinciden con su formulario y que las opciones del estado mental tienen traducción completa.
- **Navegador:** crear la nota desde la primera cita, usar las respuestas del cliente, firmar e imprimir (comparar con su PDF).

## Bueno tener (después): de la hoja a mano a la nota en la app

Idea de la terapeuta: pasar a la app lo que ya escribió a mano. No es parte de la primera versión.

1. **Leer la hoja.** Ella fotografía o escanea su hoja llenada. **Amazon Textract** lee la letra a mano y, como su formulario siempre tiene las mismas casillas, cada texto se coloca en su sección de la nota. Textract es de AWS y quedaría bajo el **BAA de AWS que ya está aceptado** (confirmar que aparece en la lista de servicios elegibles para HIPAA).
2. **Redactar en narrativa (opcional).** Un modelo de lenguaje convierte sus apuntes breves en párrafos, **sin añadir datos** que no estén en la hoja. Se haría con **Claude en Amazon Bedrock**, también bajo el BAA de AWS, en lugar de la integración directa con Anthropic, que necesita su propio BAA.

Reglas: el resultado es siempre un **borrador** que ella revisa sección por sección, con la hoja al lado; nunca se firma solo. La auditoría registra que se usó, sin el contenido. Falta decidir si la foto de la hoja se guarda como anexo de la nota o se descarta después de leerla. Sirve también para las notas de sesión y para pasar expedientes viejos en papel.

## Preguntas abiertas

1. **Menores:** pendiente de decidir (TBD). Mientras tanto, la nota de un menor usa el mismo formulario.
2. **Texto legal del aviso de consentimiento:** validar con su asesor legal en Puerto Rico.

## Esfuerzo estimado

Unos 3 días: medio día de modelo y reglas con pruebas; un día y medio del asistente, el uso de las respuestas del cliente y la traducción del estado mental; un día del reporte impreso, el chip de la ficha y la verificación en el navegador.
