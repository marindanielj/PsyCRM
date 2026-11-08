## Objetivo

Mi esposa es psicologa.  Quiero construirle un CRM sobre un code base del code base de OpenLevel y enfocarlo en Psicologos, desde el manejo de booking, checkin, documentos iniciales que debe firmar el cliente (onboarding pipeline) y sus notas.

Nuestro primer objetivo es hacer un MVP que pueda comenzar a usar la semana que viene y comenzar su práctica lo más organizada posible.

## Conoce el código
- analiza el código y entiende lo que hace y cómo está estructurado.  No necesitas darme un resumen de tu analisis.

## Parta este MVP, lo más importante que debemos planificar es:

Provee un plan de acción para los siguientes features con los que queremos arrancar el MVP:

- Tener un pipeline de onboarding donde el cliente recibe documentos que de firmar y enviar.  Claro está, de manera electrónica... desde formas que provee este CRM.  Esa información queda asociada al individio en el CRM
  - Entre los documentos de onboarding hay documentos que requieren la firma del cliente por los términos condiciones y pólizas que la práctica necesita que el cliente esté en acuerdo.

- También mi esposa, podrá documentar notas en el CRM por cada sesión. Lo ideal es que cada nota de sesión se pueda crear usando una forma que guie el proceso de tomar nota usando el formato DAP y que tambien provea para documentar el estado mental/emocional del cliente en esa sesion.

  - Las notas son CRUD, pero sometidas al punto de abajo.
    - Crear y editar notas se hacen desde la forma mencionada. Pero para "verlas" debe ser formato reporte, lista para imprimir o exportar a PDF.
  - Las notas deben seguir la seguridad de HIPPA. Pricipalmente:
    - Editable hasta 72 horas, luego no se pueden editar ni borrar.
    - Un log que audite cada cambio y actividad sobre las notas.  
  
- Un log que audite la actividad en el CRM: Creacion de cliente, log de notas (ver arriba), Cuando se ejecuta un pipeline/cuando un cliente llega a un nodo de pipeline.

## Analiza y recomienda
Haz un research, considera los features bases que incluye el codebase y Recomienda features post MVP que podríamos:

A. Construir con o sobre lo que existe
B. Crear from scratch

 que harían este CRM mucho más útil para terapistas de salud mental.