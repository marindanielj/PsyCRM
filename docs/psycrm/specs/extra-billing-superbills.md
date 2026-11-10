# Extra (A4): cobros y superbills

**Estado:** construido y probado (typecheck limpio; pruebas de librería, rutas y base de datos en PGlite; recorrido completo en el navegador, incluida la impresión a PDF). Origen: [`../PLAN_MVP.md`](../PLAN_MVP.md) §7, A4.

## Para qué

La práctica **no factura a seguros**: el cliente paga la sesión y, si su plan lo permite, pide **reembolso** (servicios fuera de red). Para eso necesita un documento que su aseguradora acepte: la **superbill**. Contiene quién atendió (con NPI y licencia), a quién, qué diagnóstico, qué servicio (código CPT), cuándo, cuánto costó y cuánto se pagó.

Esto **no** es facturación a aseguradoras (837P, elegibilidad, reclamaciones): eso es B6 y solo si algún día acepta seguros.

## Decisión de diseño: un libro de cobros propio, no el módulo `payments`

OpenLevel trae `invoices`, `products` y pagos con Stripe/Square (módulo `payments`, apagado en PsyCRM). **No se reutiliza**, por tres razones:

1. El módulo de pagos se pensó para marketing y arrastra el cobro por enlace con Stripe/Square: enviaría datos de clientes a un tercero sin BAA (ver [`INTEGRACIONES.md`](../INTEGRACIONES.md)).
2. Una factura genérica (descripción, cantidad, precio) no tiene CPT, diagnóstico ni lugar de servicio. Una superbill necesita esos datos **por servicio**.
3. Una superbill emitida debe ser **inmutable** (el cliente la entrega a un tercero). Las facturas se editan.

Por eso A4 es un módulo nuevo, `billing`, que **solo anota** lo que ya ocurrió. No cobra tarjetas ni mueve dinero.

## Modelo

### Perfil de cobro (Settings → Billing)
En `locations.settings.billing` (el nombre, la licencia, la dirección y el teléfono salen de **Practice**, que ya existe):

| Campo | Regla |
|---|---|
| NPI | 10 dígitos, con el dígito de control válido (algoritmo Luhn con el prefijo 80840). Se rechaza uno mal escrito |
| ID fiscal (EIN o SSN) | **Cifrado** (AES-256-GCM, como las direcciones del calendario). La API **nunca lo devuelve**: solo "••••1234". Se escribe y no se lee |
| Código de taxonomía | Opcional (p. ej. psicólogo clínico `103TC0700X`) |
| Lugar de servicio por telesalud | `10` (hogar del paciente, por defecto) o `02` (otro lugar) |
| Tarifas por CPT | Centavos enteros. Si falta la de ese código, la sugerencia usa el honorario de Practice (`intake` para 90791, `session` para los demás) cuando se puede leer como dinero (`$100`); si dice "escala móvil" o está vacío, la tarifa se deja para que ella la escriba |

### Cargos (`charges`): una línea por sesión
`contact_id`, `service_date`, `cpt_code`, `modifiers[]`, `place_of_service`, `units`, `diagnosis_codes[]`, `fee_cents`, `paid_cents`, `paid_at`, `payment_method`, y enlaces opcionales a la cita y a la nota (`appointment_id`, `session_note_id`).

- **Sugerencia automática** al crear desde una nota firmada: el CPT sale del tipo y la duración (`intake` → 90791; individual por duración: 16–37 min → 90832, 38–52 → 90834, 53 o más → 90837; pareja/familia → 90847; crisis → 90839; colateral → 90846), el lugar y el modificador salen de la modalidad (presencial → 11; video → 10 o 02 con modificador 95; teléfono → 10 con modificador 93) y el diagnóstico sale de los códigos de la nota. **Es una sugerencia que ella revisa**, nunca algo que se fije sola.
- Un solo cargo vivo por nota (índice único parcial).
- Dinero siempre en **centavos enteros**; nunca decimales.
- Validación: CPT de 5 dígitos (o HCPCS: letra y 4 dígitos); ICD-10-CM con su formato (`F41.1`), en mayúsculas; modificadores de 2 caracteres; lugar de servicio de 2 dígitos.
- Anular un cargo exige motivo y lo deja a la vista; no se borra.
- Pagos: se anota cuánto y cómo se pagó (efectivo, tarjeta, cheque, transferencia, otro). Una superbill muestra lo pagado, que es lo que la aseguradora quiere ver.

### Superbills (`superbills`): documento inmutable
- Se emite para **un cliente** con **uno o más de sus cargos sin emitir**. Número correlativo por práctica y año: `SB-2026-0001`.
- Guarda una **copia exacta** (`snapshot`) de lo que se emitió: proveedor, cliente, diagnósticos con sus letras A–L, líneas con apuntadores a diagnóstico, totales. Cambiar después el perfil, la tarifa o el diagnóstico **no altera** una superbill ya emitida.
- **Inmutable en la base de datos**: un trigger rechaza cambiar la copia o borrar la fila. Lo único permitido es **anularla** (con motivo), que libera sus cargos para emitir otra corregida.
- Mientras un cargo pertenece a una superbill vigente, un trigger impide cambiar su CPT, fecha, diagnóstico o tarifa. Los **pagos** sí se pueden seguir anotando (la copia emitida conserva lo pagado al emitir).
- **No se puede emitir con datos faltantes**: la API responde con la lista exacta (`provider_npi`, `provider_tax_id`, `practice_license`, `practice_address`, `charge_no_diagnosis`, `charge_zero_fee`…), igual que el riesgo en las notas. Datos opcionales de la emisión: dirección y número de afiliado del cliente (se guardan solo en la copia).
- Máximo 12 diagnósticos por superbill (como el formulario CMS-1500). Las líneas de servicio no tienen tope y, si son muchas, se imprimen en varias páginas.
- Vista imprimible en formato carta, con "CONFIDENCIAL – Información de salud protegida", la leyenda "Servicios fuera de red: este documento no es una factura ni garantiza reembolso", línea de firma del proveedor y número de superbill.

## Privacidad y auditoría

- Contiene **PHI** (nombre, fecha de nacimiento, diagnósticos). Se genera y se muestra solo dentro de la aplicación, a quien tiene sesión. **No se envía por correo** (la política es no poner PHI en el cuerpo de un correo; entregar el documento es un paso manual, imprimir o guardar PDF).
- La dirección del cliente y el afiliado van en la copia, no en el contacto.
- Auditoría, sin texto clínico, nombres, diagnósticos, direcciones ni el ID fiscal en el detalle (una prueba lo verifica sobre todo el log): `charge.created`, `charge.updated`, `charge.payment_recorded`, `charge.voided`, `superbill.issued`, `superbill.viewed`, `superbill.printed`, `superbill.voided`, `billing.profile_updated` (qué campo cambió, nunca el ID fiscal). Los pagos registran el monto anterior y el nuevo, que es el rastro financiero; los cargos registran el código CPT y la fecha, no el diagnóstico.
- El ID fiscal se cifra en reposo; la copia de una superbill lleva el valor **cifrado** y solo se abre al mostrarla.

## Fuera de alcance (y a dónde van)

Reclamaciones electrónicas y elegibilidad (B6) · cobro con tarjeta y política de cancelación tardía (A5) · enviar la superbill por un portal (B4) · cargos por cancelación tardía y paquetes de sesiones · facturas generales · impuestos.

## Cómo se enciende

Módulo nuevo `billing`. Una práctica que ya existe tiene su lista `enabledModules` guardada, así que hay que añadirlo con la sentencia del §5 de [`INTEGRACIONES.md`](../INTEGRACIONES.md). Las prácticas nuevas lo reciben por defecto. No requiere ninguna integración ni BAA: no sale ningún dato.

## Pendiente de confirmar con ella

- ¿Quiere los honorarios por CPT, o un solo precio por sesión? (se soportan los dos).
- ¿Tiene ya NPI y qué ID fiscal usa (EIN o SSN)? Sin NPI no se puede emitir.
- ¿Los códigos CPT sugeridos coinciden con cómo ella cobra (p. ej. si usa 90837 para sesiones de 60 minutos)?

## Archivos y pruebas

`db/schema.sql` (`superbills`, `charges` y sus triggers) · `server/lib/billing-vocab.ts` (reglas puras) · `server/repos/billing-repo.ts` · `server/routes/billing.ts` · `server/lib/audit-vocab.ts` · `server/lib/modules.ts` (módulo `billing`) · `src/features/billing/` (`BillingPage`, `BillingDialogs`, `SuperbillPage`, CSS de impresión) · `src/features/settings/BillingSettingsPage.tsx` · `src/lib/billing.ts`.

Pruebas: `billing-vocab.test.ts` (NPI con su dígito de control, ICD-10, CPT, dinero sin errores de coma flotante, sugerencias) · `routes/billing.test.ts` (26 pruebas sobre Postgres real: validación, sugerencias y su respaldo de tarifas, carreras entre dos solicitudes, datos faltantes al emitir, instantánea inmutable, triggers que rechazan cambios directos en SQL, anulación, aislamiento entre prácticas y privacidad del log de auditoría) · `billing-ui.test.ts` (la web interpreta el dinero igual que el servidor y cada código de error tiene un mensaje legible).

## Decisiones tomadas sin consultar

- **Una superbill por cliente y por emisión**, con los cargos que ella elija. No hay emisión automática ni por rango de fechas.
- **El pago se registra como el total pagado** (no como un abono), para poder repetirlo y corregirlo sin duplicar.
- **El ID fiscal es obligatorio para emitir.** Sin él, muchas aseguradoras rechazan el documento; si ella prefiere no imprimirlo, es un cambio de una línea.
- **Se pide el diagnóstico en cada cargo**, aunque la nota ya lo tenga: se sugiere desde la nota y ella lo confirma. Una nota sin diagnóstico (como las de la demo) obliga a escribirlo aquí.
