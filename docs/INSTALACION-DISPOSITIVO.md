# Instalación del dispositivo PaySync

Firmware `paysync-esp8266-v1.0.0`. Empezar con banco de pruebas y una base separada. El backend nuevo, las dos migraciones y el firmware deben probarse juntos. El backend de producción anterior no entrega comandos de este protocolo. Este documento no autoriza cobros reales ni cambios de claves de producción.

## Identidad: opción A, un firmware por dispositivo

El servidor lee `firmware/paysync-esp8266/PaySyncESP8266.ino` e inyecta código, token del equipo, contraseña técnica derivada del token y CA pública del backend. No contiene API_KEY, credenciales de Supabase ni token de Mercado Pago. Se eligió esta opción para impedir que el cliente cambie la identidad desde el portal y reducir errores al instalar. No cargar el mismo archivo en dos placas.

El portal normal muestra estado y permite configurar WiFi. Las acciones técnicas requieren usuario `tecnico` y contraseña propia de 24 caracteres, mostrada **solo al administrador** en `/admin/firmware`. El token no se muestra ni se modifica en el portal del ESP. La contraseña WiFi compartida `PSync1234` no es la contraseña técnica. El `.ino` generado y el binario sí contienen secretos del dispositivo: conservarlos solo para instaladores; no subirlos al repositorio ni entregarlos como documento público. Este ESP no ofrece protección contra extracción física de flash.

## Preparar servidor de prueba

1. Usar otra base Supabase y credenciales de prueba. El Preview observado anteriormente compartía variables con producción: corregir el aislamiento antes de cualquier ensayo de escritura.
2. Aplicar, una vez y en orden, `db/20260926_production_foundation.sql` y `db/20260926_esp8266_device.sql` sobre el esquema compatible, después de backup. La versión resultante es `20260926-device-v1`. Nunca ejecutar `test/fixtures/legacy-schema.sql` sobre una base real.
3. Configurar variables de [PRODUCCION.md](PRODUCCION.md). Mantener cobros reales deshabilitados. Para simulación: `NODE_ENV=development`, sin `VERCEL_ENV=production`, `ENABLE_SIMULATORS=true`, base exclusivamente de prueba. Los simuladores no consultan MP y no requieren habilitar `PAYMENTS_ENABLED`.
4. Crear un equipo ficticio, asignarlo a una empresa ficticia activa y darle abono de prueba. Fijar `pulse_duration_ms=180` en **ese equipo de prueba**. No se modifica automáticamente la duración de equipos existentes: las órdenes pagadas conservan la duración de su configuración, que puede ser 120 ms en el esquema antiguo.
5. Configurar `PUBLIC_BASE_URL` al origen HTTPS realmente accesible por la placa y `FIRMWARE_CA_PEM` a la CA que valida su certificado. La plantilla apunta por defecto a `https://qr-arcade-backend.vercel.app`; el generador usa el origen del entorno elegido. Una CA de muestra no sirve para conectar. TLS necesita hora NTP válida; se conserva verificación de certificado y dominio. [BearSSL del core ESP8266](https://arduino-esp8266.readthedocs.io/en/3.1.2/esp8266wifi/bearssl-client-secure-class.html).

## Generar y cargar con Arduino IDE

1. Como administrador, acceder a `/admin/status?key=TU_CLAVE` en el backend de prueba. Esa pantalla permite una sesión administrativa de 10 minutos. Preferir `x-api-key` o sesión Supabase para herramientas; una clave en URL queda en historial. Nunca publicarla en un QR.
2. Abrir `/admin/firmware?device=PS-000004` sustituyendo el equipo. Registrar la contraseña técnica en un almacén privado y descargar el `.ino`. `download=1` devuelve el archivo. Si falta CA o token válido, debe fallar en vez de generar firmware incompleto.
3. Guardar la descarga como `PaySyncESP8266/PaySyncESP8266.ino` fuera del repositorio. Arduino exige carpeta y archivo principal con el mismo nombre. La plantilla del repo se puede inspeccionar/compilar, pero **sin provisionar no conecta ni entrega créditos**.
4. Arduino IDE → Preferencias → URLs adicionales del gestor: `https://arduino.esp8266.com/stable/package_esp8266com_index.json`. En Gestor de placas instalar **esp8266 by ESP8266 Community 3.1.2**. Seleccionar **NodeMCU 1.0 (ESP-12E Module)**. [Instalación oficial del core](https://arduino-esp8266.readthedocs.io/en/3.1.2/installing.html).
5. Instalar **ArduinoJson 7.4.3** desde el gestor de bibliotecas. WiFi, HTTP, BearSSL, WebServer, DNS, EEPROM y LittleFS vienen con el core. No agregar bibliotecas homónimas de terceros.
6. Elegir flash de 4 MB con FS de 1 MB (`4MB (FS:1MB ...)`), CPU 80 MHz y puerto COM correcto. Cargar a 115200 si hay problemas a velocidades mayores. Verificar que la placa realmente tenga 4 MB.
7. Revisar constantes D5/D2/D7/D6, polaridades, `CASH_INPUT_SOURCE` y tiempos. En un equipo usado conservar el tamaño de FS y usar borrado **Only Sketch**. No borrar toda la flash ni subir una imagen de filesystem: borraría evidencias y eventos. Antes de actualizar, vaciar/sincronizar colas y resolver comandos pendientes.
8. Pulsar Verificar y Subir con máquina/relé de crédito desconectados. Abrir Monitor Serie a **115200**; debe mostrar versión. Los logs imprimen códigos de error y estado HTTP, nunca token ni contraseña.

## Primer arranque y WiFi

1. Unirse a `PaySync-000004` (los seis dígitos del equipo), contraseña **PSync1234**. Abrir **http://192.168.4.1/** si el portal cautivo no aparece. Desactivar cambio automático a datos móviles si el teléfono abandona la red sin Internet.
2. El AP se abre al arrancar, permanece si no hay WiFi y puede abrirse sosteniendo CONFIG D6 a GND durante 3 segundos. Con WiFi conectado se cierra tras la ventana de configuración: aproximadamente 60 segundos desde el arranque o hasta 10 minutos si se abrió por configuración/desconexión. Reset reinicia la placa y vuelve a abrir el portal.
3. En una placa nueva con flash sin LittleFS, abrir **Modo técnico**, usuario `tecnico`, contraseña de `/admin/firmware`. Sostener CONFIG y pulsar **Inicializar equipo NUEVO**. Esa acción formatea solo el almacenamiento nuevo y se bloquea después del primer montaje/inicialización. Nunca usarla para reparar una placa con registros. Si falla, revisar con instalador y conservar la flash.
4. Configurar SSID exacto de una red **2.4 GHz** y contraseña. No muestra la contraseña guardada. La reconexión se intenta cada 15 segundos; no espera indefinidamente en un bucle de arranque.
5. Esperar sincronización horaria, configuración del servidor y heartbeat. El heartbeat con telemetría es cada 30 segundos; el sondeo de comandos es cada 2.5 segundos más el tiempo de red y renueva la señal de vida. La ausencia de señal durante 30 segundos bloquea nuevos checkouts. Estas frecuencias no son garantías de latencia.

## Estado y acciones locales

La página incluye máquina/código, WiFi, RSSI, IP de red, edad del heartbeat, último pulso de relé y eventos pendientes. `/diag` añade uptime, heap, estado de almacenamiento, recibo y código de error. “Online” significa respuesta reciente del backend compatible; no confirma plan activo, habilitación comercial ni aceptación física del coin.

Al abrir Modo técnico, el dispositivo anuncia mantenimiento y deja de habilitar ventas. Se puede registrar recaudación, reiniciar, borrar WiFi y solicitar ensayo de relé. Reinicio/borrado se rechazan con recibo pendiente. Borrar WiFi conserva identidad, recibos y cola. El mantenimiento dura hasta salir o 10 minutos; no dejar una máquina en reparación confiando en ese temporizador: desconectarla/bloquearla administrativamente.

Para probar relé: desconectar COIN de la máquina, mantener CONFIG y pulsar **Probar relé**. Mantener CONFIG hasta el ensayo: con red, espera confirmación de mantenimiento del servidor; sin WiFi permite ensayo de banco. El firmware no puede detectar si el cable está físicamente desconectado. Debe cerrar COM–NO una vez durante 180 ms. El pulso es temporizado y el bucle evita HTTP/portal/escrituras mientras energiza el relé. No es un botón de crédito disponible al cliente.

La recaudación por D7 o portal queda guardada hasta confirmación del servidor. El mensaje local no promete sincronización. Una sola entrada D2 registra billetero **o** monedero. Captura por interrupción, cola persistente de 128 eventos, IDs únicos y reintentos sin duplicación. Conserva empresa e importe por pulso conocidos al capturar; si no se obtuvo configuración o cambió de empresa, el evento puede quedar bloqueado para revisión. Sincronizar efectivo y recaudación antes de reasignar. La recaudación se calcula según registros recibidos en servidor: los pagos MP tardíos pueden requerir ajuste contable del corte físico.

## Ensayo QR sin pago real

Primero comprobar un pulso real de banco. Solo en la base de prueba, habilitar la placa probada:

```sql
-- Sustituir únicamente por el dispositivo ficticio de esta prueba.
update public.paysync_runtime
set commissioned=true
where device_id=(select id from public.devices where device_code='PS-000004');
```

El simulador crea una orden y comandos: **activa el relé si la placa está conectada y habilitada**, aunque no mueve dinero. No ejecutarlo en equipos de clientes.

```powershell
# Variables de entorno privadas del laboratorio, nunca valores reales pegados al repo.
$headers = @{ 'x-api-key' = $env:API_KEY }
Invoke-RestMethod "$env:PUBLIC_BASE_URL/admin/status?format=json" -Headers $headers
Invoke-RestMethod "$env:PUBLIC_BASE_URL/test/qr-approved" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"device":"PS-000004"}'
```

Verificar orden `paid` → `relay_confirmed`, número de pulsos configurado y **créditos reales observados** cuando se conecte la máquina. Repetir un webhook/ACK en pruebas no debe repetir entrega. Si se reinicia con recibo armado (`receipt_uncertain`), debe quedar bloqueado. No borrar EEPROM ni órdenes para desbloquear; conservar evidencia y conciliar el crédito con el operador. No hay aún asistente automático para resolver esa incidencia.

En `/admin/status?format=json` revisar `online_devices`, `recent_boards`, `uptime_ms`, `free_heap`, `pending_events`, últimos QR/abonos y errores. No devuelve tokens. `mercado_pago=configured_not_verified` indica presencia de credencial, no una compra de prueba aprobada. Los errores reflejan la última falla informada por cada placa y anomalías persistidas de pago, no todos los logs distribuidos de Vercel.

## Verificación reproducible

```sh
npm ci
npm run check
npm test
npm start
# En otra consola, configurada solo para el entorno de pruebas:
npm run smoke
npm run firmware:check
```

No hay script `build` del backend. `firmware:check` requiere Arduino CLI, core 3.1.2 y ArduinoJson 7.4.3 instalados. Permite `ARDUINO_CLI`, `ARDUINO_CONFIG_FILE` y `PAYSYNC_BUILD_DIR` (ruta corta en Windows). Genera un dispositivo ficticio y compila con `esp8266:esp8266:nodemcuv2:eesz=4M1M`; **su binario no se instala**. El resultado de esta ejecución está en [VERIFICACION.md](VERIFICACION.md).

Antes de instalar en servicio: completar [lista de hardware](HARDWARE-ESP8266.md), probar cortes de energía/red y trenes de efectivo, documentar sensor o ausencia de confirmación física, disponer de soporte para pagos sin entrega, backups y alertas. El AP puede responder con pausas durante operaciones TLS síncronas; los timers no hacen todo el stack de red asíncrono. No se garantiza operación sin fallas ni créditos físicamente verificados con este hardware. Publicar/mergear y habilitar producción siguen siendo pasos separados pendientes.
