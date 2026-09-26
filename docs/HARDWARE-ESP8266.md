# PaySync ESP8266: montaje de banco y placa perforada

Diseño propuesto para NodeMCU 1.0 ESP-12E de 4 MB. El firmware se entrega para ensayo; todavía no se verificó en una placa ni en una máquina real. Antes de soldar, identificar la placa controladora de la máquina, su entrada COIN, tensión, polaridad y ancho de pulso aceptado. No deducir conexiones por colores.

## Materiales por dispositivo

| Cantidad | Elemento / condición |
| --- | --- |
| 1 | NodeMCU ESP8266 ESP-12E, 4 MB; cable USB de datos |
| 1 | Placa perforada de islas aisladas, aproximadamente 7 × 9 cm; comprobar tamaño del NodeMCU |
| 2 | Tiras hembra de 2.54 mm del largo adecuado; NodeMCU desmontable |
| 1 | Módulo relé de bobina 5 V con driver y diodo de protección, entrada **compatible con lógica 3.3 V**, activación baja y contactos COM/NO/NC |
| 1 | PC817 DIP-4 y zócalo DIP-4; revisar orientación por marca de pin 1 |
| 3 | Resistencias 10 kΩ: entrada D2, botón D7 y CONFIG D6; una cuarta para IN del relé si el módulo admite ese sesgo |
| 1 | Resistencia limitadora del LED del opto, seleccionada según tensión medida: tabla inferior |
| 1 | Diodo 1N4148 en antiparalelo al LED del opto para limitar tensión inversa |
| 2 | Pulsadores normalmente abiertos: RECAUDACIÓN y CONFIG |
| 1 | Fuente regulada externa de 5 V, capacidad de diseño 2 A; no alimentar bobina desde 3V3 |
| 1 + 1 | Capacitores 100 nF y 470 µF / 10 V en la distribución de 5 V; respetar polaridad |
| Según montaje | Borneras de paso 5.08 mm de 2/3 posiciones, cable flexible, punteras, termocontraíble, separadores y caja aislante |
| Opcional | Convertidor 12 V → 5 V regulado, protegido y dimensionado para la máquina; verificar salida antes de conectar |

La inscripción «relé 5 V» indica la bobina, no garantiza compatibilidad de IN con 3.3 V. Elegir un módulo documentado; con el ESP desconectado, medir IN y confirmar que nunca le aplica 5 V al GPIO. Un módulo con pull-up a 5 V necesita adaptación de nivel. No conectar una bobina desnuda al ESP; la bobina requiere driver y supresión de sobretensión. [Guía de protección de bobinas de Omron](https://components.omron.com/eu-en/faq/relays/FAQE10041).

## Pines y borneras

| Función | NodeMCU | GPIO | Conexión / estado de reposo |
| --- | --- | --- | --- |
| Crédito | D5 | 14 | IN del driver del relé; HIGH = apagado con `RELAY_ACTIVE_LOW=true` |
| Efectivo | D2 | 4 | Colector PC817 o contacto seco a GND; pull-up 10 kΩ a 3V3 |
| Recaudación | D7 | 13 | Pulsador a GND; pull-up 10 kΩ a 3V3 |
| Configuración | D6 | 12 | Pulsador a GND; sostener 3 segundos para abrir portal |
| Indicador | LED_BUILTIN | Según placa | LED integrado; no cablear una carga externa |
| Alimentación | USB / pin de 5 V verificado | — | 5 V regulados al NodeMCU; comprobar esquema de la variante |
| Señales | 3V3 / GND | — | Solo lógica 3.3 V del lado ESP |

J1: `+5V / GND`; J2: `COIN / COMMON` (contactos secos del relé); J3: entrada de opto rotulada según circuito positivo o colector abierto; J4: `D7 / GND`; J5: `D6 / GND`. No sacar D2 directo a una bornera de 12 V. No confundir D5 con GPIO5. Los GPIO6–11 están ligados a flash en módulos habituales y no deben reutilizarse. [Referencia del core ESP8266](https://arduino-esp8266.readthedocs.io/en/3.1.2/reference.html).

## Esquema por bloques

```text
FUENTE REGULADA 5 V
  +5V --------+------------------> VCC módulo relé
              +------------------> alimentación 5 V admitida por NodeMCU
              +-- 470uF + 100nF -- GND (en paralelo, cerca de alimentación)
  GND --------+------------------> GND driver relé / GND NodeMCU

NodeMCU D5 ----------------------> IN driver 3.3 V, activo LOW
NodeMCU 3V3 --[10k, si admite]----> IN (estado de reposo apagado)

CONTROLADORA MÁQUINA               CONTACTOS AISLADOS DEL RELÉ
  COIN --------------------------> NO
  SIGNAL COMMON -----------------> COM
                                   NC sin conectar

NodeMCU D7 ---+--- pulsador RECAUDACIÓN --- GND ESP
             +---[10k]--- 3V3
NodeMCU D6 ---+--- pulsador CONFIG -------- GND ESP
             +---[10k]--- 3V3
```

COM significa común del **contacto**, no alimentación de la bobina. El relé une temporalmente COIN con el común de señal de la máquina: no inyecta 5 V ni 12 V. Esto solo sirve si la entrada espera un cierre de contacto; si usa bus serie, protocolo propio o señal positiva, se necesita otra interfaz. Medir continuidad COM–NO sin máquina conectada, incluido encendido, reset y reconexión WiFi. La resistencia de reposo debe mantenerlo apagado también antes de ejecutar el firmware.

El relé de crédito debe ser un contacto seco dedicado. No usar los contactos para conmutar motores, premios ni alimentación. Mantener NC aislado. Los GPIO trabajan en el dominio de 3.3 V: **nunca 12 V ni 220 V en un pin del ESP**. No llevar tensión de red a esta placa perforada; usar una fuente cerrada adecuada. La interfaz exacta requiere el manual de la máquina.

## Entrada con PC817

PC817: 1 ánodo, 2 cátodo, 3 emisor, 4 colector, según el dibujo del fabricante; identificar el pin 1 por su marca, no por una vista improvisada. Lado ESP: pin 3 → GND ESP; pin 4 → D2 y resistencia 10 kΩ → 3V3. Así, luz en el opto produce un flanco descendente. [Hoja de datos Sharp, diagrama y límites eléctricos](https://global.sharp/products/device/lineup/data/pdf/datasheet/PC817XxNSZ1B_e.pdf).

Elegir **uno** de estos circuitos tras medir/documentar la salida:

```text
A. Salida que entrega un pulso POSITIVO (push-pull, tensión conocida)
   PULSE+ máquina --[R]--> pin 1 PC817
   GND señal máquina ----> pin 2 PC817

B. Salida de COLECTOR ABIERTO que conduce a masa al pulsar
   +V máquina -----[R]---> pin 1 PC817
   PULSE/sink máquina ---> pin 2 PC817
   El emisor del sensor original debe estar referenciado a GND máquina.

Ambos:
   1N4148 antiparalelo al LED: cátodo al pin 1, ánodo al pin 2.
   [barrera óptica: no unir señales de ambos lados]
   pin 4 PC817 ---+------> D2
                 +--[10k]--> 3V3 ESP
   pin 3 PC817 ----------> GND ESP
```

Valores iniciales calculados con aproximadamente 5 mA y caída LED estimada 1.2 V (`R=(V−1.2)/0.005`): 5 V → 820 Ω; 12 V → 2.2 kΩ; 24 V → 4.7 kΩ. Usar 0.5 W para margen y verificar corriente, tensión y límites de la salida real. Son cálculos de diseño, no una autorización para conectar una señal desconocida. No poner el LED del opto sin resistencia. La separación óptica de señales no garantiza aislamiento galvánico del sistema si una fuente común vuelve a unir ambas masas.

Para contacto seco genuino, puede usarse D2 con pull-up 10 kΩ a 3V3 y contacto a GND ESP. **Una salida activa de billetero no es un contacto seco.** D2 registra una sola fuente: elegir `CASH_INPUT_SOURCE="billetero"` o `"monedero"`. No unir dos salidas de dinero entre sí. Para diferenciarlas simultáneamente hace falta ampliar hardware y firmware con otra entrada.

## Montaje en placa perforada

1. Dibujar distribución con NodeMCU extraíble, USB accesible, relé alejado de la antena y borneras al borde. Mantener antena libre de cobre/cables/chasis metálico próximo.
2. Soldar zócalos, borneras y puentes sin NodeMCU. Rotular alimentación, polaridad, COIN, CASH, RECAUDACIÓN y CONFIG. No usar protoboard ni jumpers sueltos para instalación final.
3. Llevar alimentación del relé y del NodeMCU por ramas separadas desde J1; no pasar corriente de bobina por pistas finas de señal. Colocar desacople y alivio mecánico de cables.
4. Mantener lados de máquina y ESP separados alrededor del opto y contactos. Revisar soldaduras con lupa y medir que no haya cortos entre 5V, 3V3, GND y contactos.
5. Energizar primero la fuente sin NodeMCU; medir 5 V y luego 3.3 V en la placa, en reposo y durante WiFi/relé. Evitar alimentar simultáneamente USB y fuente externa salvo que el esquema del NodeMCU lo permita.
6. Insertar NodeMCU, cargar firmware y probar sin conectarlo a la máquina. Montar en caja con separadores; que ninguna soldadura toque metal.

## Prueba y aceptación del equipo

- [ ] Fuente estable, módulo relé documentado para 3.3 V, reposo apagado al arrancar/resetear.
- [ ] Instalar y configurar como indica [INSTALACION-DISPOSITIVO.md](INSTALACION-DISPOSITIVO.md).
- [ ] Ensayo local: COM–NO cierra aproximadamente 180 ms, una vez; confirmar con osciloscopio/analizador si está disponible.
- [ ] Efectivo: diez pulsos separados más de 350 ms producen diez eventos. Repetir mientras hay TLS, sin WiFi y tras reconectar; una sola carga de cada evento.
- [ ] Medir el tren real del billetero: el filtro de 350 ms descarta pulsos más cercanos. Ajustarlo solo tras comprobar el protocolo y fijar el importe **por pulso**, no por billete.
- [ ] D7: cada pulsación separada al menos 1500 ms guarda una recaudación. Verificar que los reintentos no crean duplicados.
- [ ] Con máquina apagada, cablear COIN/COMMON identificado. Luego encender y ensayar crédito sin dinero; comprobar que una activación equivale al crédito esperado.
- [ ] Ensayar QR simulado en entorno separado. Registrar código, firmware, tensión, polaridad, duración, señal medida y créditos reales obtenidos.
- [ ] Cortar red/energía antes, durante y después del comando; tras reinicio ambiguo debe bloquearse para revisión, nunca repetir automáticamente.
- [ ] Ensayo continuo de 48–72 horas con red intermitente y registro de heap, resets y créditos. Es un ensayo propuesto, no realizado.

No hay sensor de aceptación de crédito en este montaje. Para afirmar que la máquina **recibió** el coin hace falta retorno de su controladora o sensor adecuado y ampliar el protocolo. La cola tiene 128 eventos persistidos y 63 posiciones útiles en RAM; una caída eléctrica antes de grabar un flanco, un tren demasiado rápido, flash dañada o cola llena puede perder efectivo. Sin una línea de inhibición del aceptador no puede impedirse físicamente que entre dinero cuando el registro falla. Para explotación intensiva evaluar FRAM, respaldo de energía y entrada de inhibición; el montaje actual no certifica contabilidad sin pérdidas.
