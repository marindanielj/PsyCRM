# Futuro (B12): documentación asistida por IA en la teleconsulta

**Estado:** planificado con la terapeuta el 23 de noviembre de 2026, **no construido**. Depende de la fase 2 de telesalud (video integrado con Amazon Chime SDK, ver [`future-telehealth.md`](future-telehealth.md)).

## Qué es
Durante una **teleconsulta** (solo virtual), la app transcribe la conversación y, al terminar, produce un **borrador** de la nota que corresponda: la **entrevista inicial (intake)** o la **nota de sesión (DAP)**. La terapeuta lo revisa, lo corrige y lo firma. La IA nunca firma ni decide.

## Decisiones tomadas
| Tema | Decisión |
|---|---|
| Dónde se usa | **Solo en sesiones virtuales.** No se graba en sesiones presenciales: a la terapeuta le preocupa que el cliente se sienta incómodo con una grabación en la oficina |
| Idioma | **Español.** Las sesiones hoy son en español |
| Qué nota se llena | **Una de las dos**, y se elige **antes de grabar**: entrevista inicial (su formulario, B11) o nota de sesión (DAP). La IA no adivina el tipo |

## Cómo funciona
1. **Antes de empezar**, en la sala virtual, la terapeuta elige "Entrevista inicial" o "Nota de sesión" y pulsa **Grabar para documentar**. El botón solo aparece si el cliente firmó el consentimiento (ver Reglas).
2. **Durante la sesión**, el audio de la reunión de Chime pasa a **Amazon Transcribe** en español (`es-US`), que separa a quién habla: terapeuta o cliente. Hay un indicador visible de grabación para los dos, y la terapeuta puede pausarla o detenerla.
3. **Al terminar**, **Claude en Amazon Bedrock** lee la transcripción y llena el formato elegido:
   - **Intake:** las secciones de su formulario (queja, historial del problema, funcionamiento por áreas, historiales, peligrosidad, factores protectivos, metas, expectativas).
   - **Sesión:** Data (subjetivo y objetivo), Assessment y Plan.

   Cada parte del borrador indica de qué fragmento de la transcripción salió, para que ella lo verifique.
4. **Revisión:** el borrador se abre en el asistente de notas que ya existe, como cualquier borrador. Ella edita y firma. Las 72 horas empiezan al firmar, como en toda nota.

Transcribe, Bedrock y Chime quedan bajo el **BAA de AWS que ya está aceptado**. Antes de construir hay que confirmar que los tres están en la lista vigente de servicios elegibles para HIPAA.

## Reglas
- **El riesgo no lo contesta la IA.** Las notas nunca rellenan el riesgo por adelantado, porque un "Negada" que nadie evaluó sería falso en el expediente. La IA solo **señala** los fragmentos donde se habló de ideación, autolesión, daño a otros o crisis; las respuestas las marca ella. Lo mismo aplica al estado mental: la IA puede sugerir, ella confirma cada opción.
- **Consentimiento escrito del cliente** para grabar la teleconsulta y usar documentación asistida por IA: una plantilla nueva en Documentos, que puede firmarse con el paquete de bienvenida. Sin consentimiento firmado no hay botón de grabar, y la sesión funciona igual sin grabación. El texto debe validarlo su asesor legal.
- **Guardar lo mínimo.** El audio no se guarda: se transcribe en vivo. La transcripción se guarda **solo hasta que se firma la nota**, y como máximo N días (por decidir) si nunca se firma. En el expediente queda la nota firmada, no la transcripción.
- **Trazabilidad.** El historial de la nota indica que el primer borrador vino de la IA y qué cambió ella. La auditoría registra que se grabó y que se generó el borrador, sin contenido.
- **El cliente puede pedir que se detenga** en cualquier momento, y la terapeuta la detiene. Lo transcrito hasta ahí se puede descartar.

## Costo aproximado por sesión de 50 minutos
- **Transcripción:** del orden de un dólar.
- **Redacción con Claude:** centavos.

Son estimados; hay que confirmarlos con las tarifas vigentes de AWS.

## Esfuerzo y orden
1. **Fase 2 de telesalud** (video con Chime): una a dos semanas.
2. **Transcripción en vivo**, con indicador y control de grabación: alrededor de una semana.
3. **Borrador de intake y de sesión** a partir de la transcripción, con sus fuentes: una a dos semanas, sobre todo afinando las instrucciones y probando con sesiones de ensayo (nunca con clientes reales).
4. **Plantilla de consentimiento**: días.

El "traductor" de su hoja escrita a mano (bueno tener, en [`future-intake-notes.md`](future-intake-notes.md)) usaría el mismo paso de Bedrock.

## Preguntas abiertas
1. Cuántos días se guarda una transcripción si la nota nunca se firma.
2. Si hace falta que el cliente vea y acepte, al entrar a la sala, que la sesión se está transcribiendo (además del consentimiento firmado). Recomendación: sí, un aviso al entrar.
3. Probar la calidad de Transcribe con el español de Puerto Rico y el "spanglish" antes de comprometer el diseño.
