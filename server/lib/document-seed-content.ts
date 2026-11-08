import type { SignerRole, TemplateField } from './document-vocab'

/**
 * Starter templates (Spanish). They are seeded as DRAFTS: the text is a reasonable
 * starting point, NOT legal advice. The therapist or a legal adviser must review and
 * adapt each one (licence number, local law, her own policies) before activating it.
 */
export interface SeedTemplate {
  slug: string
  kind: 'agreement' | 'intake_form'
  title: string
  signerRoles: SignerRole[]
  bodyMd: string
  fields: TemplateField[]
}

const CRISIS = '- Línea 988 de prevención del suicidio y crisis (llamar o texto al **988**)\n- Línea PAS (Primera Ayuda Psicológica) de Puerto Rico: **1-800-981-0023**\n- Emergencias: **911**'

const initials = (key: string, label: string): TemplateField => ({ key, type: 'initials', label, required: true })
const text = (key: string, label: string, extra: Partial<TemplateField> = {}): TemplateField => ({ key, type: 'text', label, ...extra })
const area = (key: string, label: string, extra: Partial<TemplateField> = {}): TemplateField => ({ key, type: 'textarea', label, ...extra })
const yesNo = (key: string, label: string, extra: Partial<TemplateField> = {}): TemplateField => ({ key, type: 'yes_no', label, required: true, ...extra })

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    slug: 'informed_consent',
    kind: 'agreement',
    title: 'Consentimiento informado para servicios de psicoterapia',
    signerRoles: ['client'],
    bodyMd: `Yo, **{{client.full_name}}**, solicito servicios de psicoterapia con **{{practice.therapist}}** (licencia {{practice.license}}), en **{{practice.name}}**.

## Naturaleza del servicio
La psicoterapia es un proceso colaborativo. Puede ayudar a manejar dificultades emocionales, de conducta y de relaciones, pero **no se garantiza un resultado particular**. Entiendo que el proceso puede traer emociones incómodas, y que puedo hacer preguntas en cualquier momento.

## Beneficios y riesgos
Entre los beneficios posibles están una mejor comprensión de mí mismo/a, mejores relaciones y alivio de síntomas. Entre los riesgos, recordar experiencias dolorosas o sentirme peor por momentos.

## Duración y frecuencia
Las sesiones duran aproximadamente 50 minutos y la frecuencia se acuerda con mi terapeuta.

## Límites de la confidencialidad
Lo que converso en sesión es confidencial, con estas excepciones:

- Si existe un riesgo serio de que yo me haga daño o le haga daño a otra persona.
- Si hay sospecha de abuso o negligencia hacia menores, personas de edad avanzada o personas con incapacidad.
- Si un tribunal lo ordena legalmente.
- Si yo autorizo por escrito compartir información con otra persona o profesional.

{{field:iniciales_confidencialidad}}

## Mi derecho a terminar
Puedo terminar el tratamiento en cualquier momento. Se recomienda una sesión de cierre.

## En caso de emergencia
Mi terapeuta no ofrece servicios de emergencia. Si estoy en crisis, me comunicaré con:

${CRISIS}

{{field:acepto}}`,
    fields: [
      initials('iniciales_confidencialidad', 'Iniciales: entiendo los límites de la confidencialidad'),
      { key: 'acepto', type: 'checkbox', label: 'He leído este documento, he podido hacer preguntas y doy mi consentimiento informado.', required: true },
    ],
  },
  {
    slug: 'privacy_notice',
    kind: 'agreement',
    title: 'Aviso de prácticas de privacidad (HIPAA)',
    signerRoles: ['client'],
    bodyMd: `**{{practice.name}}** · {{practice.address}} · {{practice.phone}}

Este aviso describe cómo se puede usar y divulgar su información de salud y cómo usted puede tener acceso a ella.

## Cómo usamos y divulgamos su información
- **Tratamiento:** para coordinar su cuidado con otros profesionales, con su autorización.
- **Pago:** para facturar o gestionar reembolsos con su plan médico, si aplica.
- **Operaciones:** para la administración y la calidad del servicio.
- **Según lo exija la ley:** por ejemplo, ante riesgo serio de daño o sospecha de abuso.

## Sus derechos
- Pedir una copia de su expediente y revisarlo.
- Pedir enmiendas a información que considere incorrecta.
- Recibir un registro de las divulgaciones.
- Pedir restricciones o comunicaciones por un medio alterno.
- Recibir una copia de este aviso.

## Quejas
Si cree que sus derechos de privacidad fueron violados, puede presentar una queja con **{{practice.therapist}}** o con la Oficina de Derechos Civiles (OCR) del Departamento de Salud y Servicios Humanos de EE. UU. No habrá represalias.

Fecha de vigencia: {{today}}

{{field:acuse}}`,
    fields: [{ key: 'acuse', type: 'checkbox', label: 'Acuso recibo de este Aviso de prácticas de privacidad.', required: true }],
  },
  {
    slug: 'cancellation_policy',
    kind: 'agreement',
    title: 'Política de cancelación y ausencias',
    signerRoles: ['client'],
    bodyMd: `Su cita está reservada exclusivamente para usted. Por eso:

- Las citas se cancelan o se cambian con al menos **{{policy.cancel_hours}} horas** de aviso.
- Las cancelaciones con menos aviso, y las ausencias sin aviso, tienen un cargo de **{{fees.late_cancel}}**.
- Si hay ausencias repetidas, podemos conversar sobre el horario o la continuidad del servicio.
- Si cancela por una emergencia, lo conversamos caso a caso.

{{field:iniciales_cancelacion}}`,
    fields: [initials('iniciales_cancelacion', 'Iniciales: entiendo y acepto esta política')],
  },
  {
    slug: 'fee_policy',
    kind: 'agreement',
    title: 'Política de honorarios y pagos',
    signerRoles: ['client'],
    bodyMd: `## Honorarios
- Evaluación inicial: **{{fees.intake}}**
- Sesión individual: **{{fees.session}}**

## Pagos
El pago se realiza al finalizar cada sesión, salvo que se acuerde otra cosa. Si lo necesita, se le entrega un recibo con la información para solicitar reembolso a su plan médico.

## Saldos pendientes
Si hay un saldo pendiente, conversaremos un plan de pago antes de continuar.

{{field:metodo_pago}}

{{field:acepto_honorarios}}`,
    fields: [
      { key: 'metodo_pago', type: 'radio', label: 'Método de pago preferido', required: true, options: [
        { value: 'efectivo', label: 'Efectivo' }, { value: 'tarjeta', label: 'Tarjeta' }, { value: 'ath', label: 'ATH Móvil' }, { value: 'otro', label: 'Otro' },
      ] },
      { key: 'acepto_honorarios', type: 'checkbox', label: 'He leído y acepto la política de honorarios y pagos.', required: true },
    ],
  },
  {
    slug: 'telepsychology',
    kind: 'agreement',
    title: 'Consentimiento para telepsicología',
    signerRoles: ['client'],
    bodyMd: `Algunas sesiones pueden ofrecerse por video o teléfono. Entiendo que:

- Debo estar en un **lugar privado**, sin otras personas que puedan escuchar, y usar una conexión segura.
- La tecnología puede fallar. Si se cae la conexión, mi terapeuta intentará llamarme al teléfono que le di; si no me alcanza, reprogramamos.
- Al inicio de cada sesión debo indicar **dónde me encuentro físicamente**, para poder ayudar en una emergencia.
- No se permite grabar la sesión sin acuerdo previo por escrito.
- En una emergencia llamaré al:

${CRISIS}

{{field:telefono_contingencia}}

{{field:acepto_tele}}`,
    fields: [
      { key: 'telefono_contingencia', type: 'phone', label: 'Teléfono donde puedo ser localizado/a si se cae la conexión', required: true },
      { key: 'acepto_tele', type: 'checkbox', label: 'Doy mi consentimiento para recibir servicios por telepsicología.', required: true },
    ],
  },
  {
    slug: 'electronic_comms',
    kind: 'agreement',
    title: 'Consentimiento de comunicaciones electrónicas',
    signerRoles: ['client'],
    bodyMd: `El correo electrónico y los mensajes de texto **no son completamente seguros** y pueden ser leídos por otras personas si alguien accede a mi dispositivo o cuenta.

Por eso, entiendo que estos medios se usarán **solo para asuntos de logística** (confirmar, cambiar o recordar citas), y no para hablar de temas clínicos. Para una emergencia no debo usar mensajes: llamaré al 988 o al 911.

{{field:medios}}

{{field:acepto_comunicaciones}}`,
    fields: [
      { key: 'medios', type: 'checkbox_group', label: 'Autorizo que me contacten por', options: [
        { value: 'llamada', label: 'Llamada' }, { value: 'sms', label: 'Mensaje de texto' }, { value: 'email', label: 'Correo electrónico' },
      ] },
      { key: 'acepto_comunicaciones', type: 'checkbox', label: 'Entiendo los riesgos y acepto estas condiciones.', required: true },
    ],
  },
  {
    slug: 'intake_form',
    kind: 'intake_form',
    title: 'Cuestionario de admisión',
    signerRoles: ['client'],
    bodyMd: `Esta información es confidencial. Puede dejar en blanco lo que prefiera conversar en persona.`,
    fields: [
      { key: 'h_personal', type: 'heading', label: 'Datos personales' },
      text('first_name', 'Nombre', { required: true, mapsTo: 'first_name' }),
      text('last_name', 'Apellidos', { required: true, mapsTo: 'last_name' }),
      { key: 'date_of_birth', type: 'date', label: 'Fecha de nacimiento', required: true, mapsTo: 'custom:date_of_birth' },
      { key: 'email', type: 'email', label: 'Correo electrónico', mapsTo: 'email' },
      { key: 'phone', type: 'phone', label: 'Teléfono', required: true, mapsTo: 'phone' },
      { key: 'h_emergency', type: 'heading', label: 'Contacto de emergencia' },
      text('emergency_name', 'Nombre', { required: true, mapsTo: 'custom:emergency_contact_name' }),
      { key: 'emergency_phone', type: 'phone', label: 'Teléfono', required: true, mapsTo: 'custom:emergency_contact_phone' },
      { key: 'h_reason', type: 'heading', label: 'Motivo de consulta' },
      area('reason', '¿Qué lo/la trae a terapia en este momento?', { required: true }),
      area('goals', '¿Qué espera lograr con la terapia?'),
      { key: 'h_history', type: 'heading', label: 'Historial' },
      yesNo('prior_therapy', '¿Ha recibido tratamiento de salud mental antes?'),
      area('prior_therapy_detail', 'Cuéntenos brevemente (cuándo, con quién, cómo le fue)', { showIf: { key: 'prior_therapy', equals: 'yes' } }),
      yesNo('takes_meds', '¿Toma algún medicamento actualmente?'),
      area('meds_list', 'Medicamentos y dosis', { showIf: { key: 'takes_meds', equals: 'yes' } }),
      area('health', 'Condiciones de salud física importantes'),
      { key: 'substances', type: 'select', label: 'Consumo de alcohol u otras sustancias', options: [
        { value: 'ninguno', label: 'Ninguno' }, { value: 'ocasional', label: 'Ocasional' }, { value: 'frecuente', label: 'Frecuente' }, { value: 'prefiero_hablar', label: 'Prefiero conversarlo en persona' },
      ] },
      area('family_history', 'Historial de salud mental en la familia'),
      area('support', 'Personas que lo/la apoyan (familia, amistades, comunidad)'),
    ],
  },
  {
    slug: 'guardian_consent',
    kind: 'agreement',
    title: 'Consentimiento del padre, madre o tutor (menor de edad)',
    signerRoles: ['guardian'],
    bodyMd: `Yo, en mi capacidad de padre, madre o tutor legal, autorizo que el/la menor **{{client.full_name}}** reciba servicios de psicoterapia con **{{practice.therapist}}** en **{{practice.name}}**.

## Autoridad legal
Declaro que tengo la autoridad legal para consentir a este tratamiento. {{field:relacion}}

## Información que se comparte y confidencialidad
Para que la terapia funcione, el/la adolescente necesita un espacio de confianza. Por eso, el contenido de las sesiones es confidencial. Se informará al padre, madre o tutor sobre asuntos generales (asistencia, progreso en términos amplios), y **siempre** si hay un riesgo serio de daño o sospecha de abuso.

## Cancelación y pagos
Soy responsable de los pagos y de cumplir la política de cancelación (**{{policy.cancel_hours}} horas** de aviso; cargo de {{fees.late_cancel}}). La sesión tiene un costo de {{fees.session}}.

## En caso de emergencia
${CRISIS}

{{field:acepto_tutor}}`,
    fields: [
      { key: 'relacion', type: 'select', label: 'Mi relación con el/la menor', required: true, options: [
        { value: 'madre', label: 'Madre' }, { value: 'padre', label: 'Padre' }, { value: 'tutor', label: 'Tutor/a legal' },
      ] },
      { key: 'acepto_tutor', type: 'checkbox', label: 'He leído este documento y doy mi consentimiento.', required: true },
    ],
  },
  {
    slug: 'minor_assent',
    kind: 'agreement',
    title: 'Asentimiento del menor',
    signerRoles: ['minor'],
    bodyMd: `Hola, **{{client.first_name}}**. Esto es para que sepas cómo funciona la terapia.

- En terapia vamos a conversar de lo que te preocupa y buscar formas de sentirte mejor.
- Lo que me cuentes **se queda entre nosotros**. Solo se lo diría a tus padres o a otra persona si pienso que tú o alguien más está en peligro, o si alguien le está haciendo daño a un menor.
- Puedes hacer preguntas cuando quieras y puedes decirme si algo no te gusta.
- Si estás en una emergencia, llama al **988** o al **911**.

{{field:entiendo}}`,
    fields: [{ key: 'entiendo', type: 'checkbox', label: 'Lo leí, lo entendí y estoy de acuerdo en venir a terapia.', required: true }],
  },
]

export interface SeedPacket {
  slug: string
  name: string
  description: string
  audience: 'adult' | 'adolescent'
  slugs: string[]
}

export const SEED_PACKETS: SeedPacket[] = [
  {
    slug: 'adult',
    name: 'Onboarding – Adulto',
    description: 'Para clientes de 18 años o más. Agregue telepsicología si aplica.',
    audience: 'adult',
    slugs: ['informed_consent', 'privacy_notice', 'cancellation_policy', 'fee_policy', 'electronic_comms', 'intake_form'],
  },
  {
    slug: 'adolescent',
    name: 'Onboarding – Adolescente',
    description: 'Para menores de 18: lo firma el padre, madre o tutor, y el menor da su asentimiento.',
    audience: 'adolescent',
    slugs: ['guardian_consent', 'minor_assent', 'privacy_notice', 'cancellation_policy', 'fee_policy', 'intake_form'],
  },
]
