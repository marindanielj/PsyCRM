# Extra (A4, parte 2): facturas y recibos desde un cargo

**Estado:** construido y probado (typecheck limpio; pruebas sobre Postgres real; recorrido completo en el navegador, incluida la impresión a PDF). Continúa [`extra-billing-superbills.md`](extra-billing-superbills.md).

## Qué se hace con un cargo

Un cargo (una sesión: código, fecha, tarifa) es el punto de partida de **tres documentos**:

| Documento | Para quién | Qué dice | Idioma |
|---|---|---|---|
| **Superbill** | La aseguradora del cliente (reembolso fuera de red) | Proveedor con NPI e ID fiscal, diagnósticos, códigos CPT | Inglés (ya hecha) |
| **Factura** (*invoice*) | El cliente: lo que debe | Servicio, fecha, importe, vencimiento | **Español** |
| **Recibo** (*receipt*) | El cliente: lo que pagó | Qué se pagó, cuándo, cómo, saldo restante | **Español** |

Factura y recibo son documentos **para el cliente**, y la regla del proyecto es que los documentos de cara al cliente van en español (la interfaz de la terapeuta sigue en inglés).

## Qué existía y por qué no se reutilizó

OpenLevel trae `invoices` (módulo `payments`, apagado en PsyCRM). **No existían recibos.** Las facturas de OpenLevel no sirven aquí por las mismas razones que ya se dieron para la superbill, y por una más:

- Cobran con enlaces de Stripe o Square: datos del cliente a un tercero sin BAA.
- Líneas de texto libre, sin código, fecha de servicio ni vínculo con la sesión.
- Marcan **toda** la factura como pagada con un método escrito a mano: no hay pagos parciales, ni fecha de pago, ni dos pagos distintos.
- No escriben nada en el log de auditoría y no son inmutables.

El módulo `payments` de OpenLevel **sigue apagado**. Facturas y recibos nuevos viven en el módulo `billing`, junto a las superbills.

## Decisiones de diseño

### 1. Los pagos pasan a ser un libro propio
Hasta ahora un cargo guardaba "el total pagado" (un número que se podía reescribir). Un recibo exige otra cosa: **cada pago es un hecho con su fecha, su monto y su método**, y el recibo es la prueba de ese pago. Por eso:

- Tabla nueva `payments`: una fila por cargo pagado, con monto, método y fecha. **No se edita ni se borra**; solo se anula, con motivo.
- Un pago puede cubrir varios cargos (el cliente paga tres sesiones de una vez): son varias filas de `payments` y **un solo recibo**.
- `charges.paid_cents` sigue existiendo, pero como **cifra derivada**: la suma de los pagos no anulados, que el sistema recalcula dentro de la misma transacción. La superbill y las listas la siguen leyendo igual.
- Se elimina la acción "fijar el total pagado". En su lugar: **registrar un pago** (crea el recibo) y **anular un recibo** (anula sus pagos y recalcula).

### 2. Un recibo por pago, emitido al registrarlo
Registrar un pago y emitir su recibo es **una sola acción**: no existe un pago sin recibo ni un recibo sin pago. Así el número del recibo nunca queda "pendiente" y cada peso entrado tiene su comprobante. Anular un recibo anula los pagos que prueba.

### 3. La factura se congela; su estado, no
- La factura guarda una **copia exacta** de lo que se emitió (servicio, fecha, importe, vencimiento). Cambiar luego una tarifa no altera una factura ya emitida.
- Su **estado** (abierta, pagada, anulada) y su **saldo** se calculan en vivo a partir de los pagos de sus cargos, para que un pago nuevo se vea al instante sin tocar el documento.
- Un cargo puede estar en **una factura y una superbill a la vez**; son independientes.
- Mientras un cargo está en una factura o superbill vigente, no se puede cambiar su código, fecha, diagnóstico ni tarifa (trigger en la base de datos); los pagos sí se siguen registrando.
- Anular una factura la deja visible y libera sus cargos para emitir otra corregida. Los números no se reutilizan.

### 4. Privacidad: lo que NO llevan factura ni recibo
Estos documentos los puede ver el empleador, un familiar o un banco. Por eso **no llevan** diagnóstico, código CPT, ID fiscal ni NPI. Solo un texto genérico del servicio ("Evaluación inicial", "Sesión de terapia individual"…). El ID fiscal (que en su caso es un seguro social) **no se imprime nunca** en ellos.

### 5. ATH Móvil
Se añade `ath_movil` a los métodos de pago (efectivo, tarjeta, cheque, transferencia, **ATH Móvil**, otro). Se muestra "ATH Móvil" en los documentos.

## Datos

- `billing_invoices`: número `FAC-AAAA-NNNN`, cliente, copia congelada, vencimiento, anulación (motivo). Inmutable salvo anular.
- `billing_receipts`: número `REC-AAAA-NNNN`, cliente, fecha, método, copia congelada, anulación. Inmutable salvo anular.
- `payments`: cargo, recibo, monto (> 0), método, fecha. Solo se anula.
- `charges.invoice_id` (nuevo, como `superbill_id`).
- Método `ath_movil` también en la restricción de `charges.payment_method` (la tabla ya existe en producción, así que se cambia con `ALTER`, idempotente).

## Reglas al registrar un pago
Cada línea del pago debe ser de un cargo **vivo** del mismo cliente y de esta práctica, con un monto entre 1 centavo y el **saldo pendiente** de ese cargo (nunca más de lo que falta). Dos pagos simultáneos sobre el mismo cargo no pueden pasarse del saldo (el cargo se bloquea durante el registro). La fecha del pago no puede ser futura.

## Reglas al emitir una factura
Cargos vivos, del mismo cliente, que no estén ya en una factura vigente, con tarifa mayor que cero. Faltan datos → la respuesta lista exactamente cuáles (`provider_name`, `practice_address`, `charge_zero_fee`). No exige NPI, ID fiscal ni diagnóstico (eso es solo de la superbill). Importe de la factura = tarifa − lo ya pagado al emitirla.

## Auditoría
`invoice.issued|viewed|printed|voided`, `receipt.issued|viewed|printed|voided`, `payment.recorded`. Los detalles llevan números de documento, método y montos; nunca nombres, diagnósticos ni el ID fiscal (una prueba lo verifica sobre todo el log).

## Interfaz
**Billing** pasa a tener cuatro pestañas: *Charges*, *Invoices*, *Receipts* y *Superbills*. Al seleccionar cargos de **un** cliente aparecen tres acciones: **Record payment** (crea el pago y su recibo), **Create invoice** y **Create superbill**; cada una se desactiva con una explicación si no aplica (por ejemplo, un cargo ya en una factura). Cada cargo muestra su estado de pago (*Unpaid*, *Partial*, *Paid*) y los documentos en que está. Desde una factura abierta, **Record payment** lleva directo al recibo. Factura y recibo se imprimen como una sola página carta, en español, sin nada de la aplicación alrededor. **Los tres documentos (factura, recibo y superbill) llevan el logo de la práctica** (el de Settings → Branding) a la izquierda del título; sin logo salen exactamente como antes. Es un membrete, no parte de lo emitido: se lee al mostrar la página, así que un logo nuevo aparece al reimprimir un documento viejo. Se verificó que cada PDF lleva una sola imagen con logo y ninguna sin él, y que siguen siendo de una página.

## Archivos y pruebas
`db/schema.sql` (`billing_invoices`, `billing_receipts`, `payments`, `charges.invoice_id`, el trigger común `void_only_guard` y el trigger de cargos reescrito) · `server/lib/billing-vocab.ts` (ATH Móvil, textos en español, numeración) · `server/repos/billing-documents-repo.ts` · `server/routes/billing-documents.ts` · `server/repos/billing-repo.ts` (los cargos ya no "fijan" un total) · `src/features/billing/` (`BillingPage`, `PaymentDialogs`, `InvoicePage`, `ReceiptPage`, `doc-print.css`) · `src/lib/billing.ts`.

Pruebas: `routes/billing-documents.test.ts` (22 pruebas sobre Postgres real: ATH Móvil, recibo con su saldo, un pago sobre varios cargos, todo o nada, dos pagos a la vez, el total derivado frente a los pagos, anular un recibo, triggers que rechazan cambios directos en SQL, facturas con su estado en vivo, una factura y una superbill sobre el mismo cargo, aislamiento entre prácticas y privacidad del log) y las 25 de `billing.test.ts` adaptadas. Se verificó con una **prueba de mutación** que romper la regla de privacidad o el tope de lo adeudado hace fallar los tests. El esquema se probó además **sobre una copia de la base tal como está en producción** (con la tabla `charges` ya creada y con datos): la restricción de método de pago se cambia en su lugar, los datos se conservan y los triggers siguen vigentes.

## Decisiones tomadas sin consultar
- **Español para el cliente.** Factura y recibo van en español porque los lee el cliente (regla del proyecto). La superbill sigue en inglés (la lee la aseguradora). Si ella prefiere un recibo bilingüe, entra con el trabajo de C1/C2.
- **Números `FAC-AAAA-NNNN` y `REC-AAAA-NNNN`**, uno por práctica y año, sin reutilizarse.
- **Descripciones genéricas** del servicio ("Evaluación inicial", "Sesión de terapia individual", "Sesión de pareja o familia", "Sesión de crisis"). Si quiere otras palabras, está en `serviceDescription` (`server/lib/billing-vocab.ts`).
- **Una factura no se paga "entera"**: se registran pagos (parciales o completos) y la factura se ve *Open* o *Paid* según lo que falte. El vencimiento es opcional; una factura abierta con vencimiento pasado se marca *overdue*.
- **El motivo de una anulación vive en el documento, no en el log de auditoría**, también para los cargos y las superbills que se habían hecho antes (corrección de privacidad).
- **No hay "total pagado" editable**: un pago equivocado se corrige anulando su recibo.

## Fuera de alcance
Cobro con tarjeta o enlace de pago (A5) · envío por correo (los documentos llevan datos de salud; se imprimen o guardan como PDF) · notas de crédito y reembolsos (se anula y se emite de nuevo) · impuestos · facturas recurrentes · acceso desde la ficha del cliente (se planea aparte, a continuación).
