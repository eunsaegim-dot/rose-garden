// 체감시간의 정원 — Arduino UNO R3 입출력 브릿지 (참고용 스케치)
//
// 이미 버튼 1/버튼 2가 BUTTON_1_TIME_MEASURE / BUTTON_2_PLAY_RESULT를
// 디바운스 + 1-엣지-1-라인으로 보내고 있다면 그 부분은 그대로 두고,
// 아래 중 "웹 -> 보드" 명령 수신부(handleSerialLine)와 D10/D11 핀 처리만
// 기존 코드에 추가하면 됩니다. 핀 배치·보율은 이미 확정된 사양을 따름.
//
// [보드 -> 웹] 누를 때마다 '\n'으로 끝나는 한 줄만 전송 (눌려 있는 동안
// 반복 전송하지 않음 — 반복되면 웹 쪽 토글이 계속 뒤집힘):
//   BUTTON_1_TIME_MEASURE   D7 버튼 — 체감시간 측정 시작/종료 토글 요청
//   BUTTON_2_PLAY_RESULT    D8 버튼 — 전체 음악 재생 토글 요청
//
// [웹 -> 보드]:
//   VIBRATE_ON / VIBRATE_OFF   D10 PWM 진동 모터 — 세기 조절 없음, 항상
//                              같은 고정 듀티 하나만 사용(VIBRATION_DUTY)
//   MEASURE_ON / MEASURE_OFF   D11 LED — 웹의 실제 측정 상태를 그대로 반영
//
// 통신: 9600 baud. 버튼은 INPUT_PULLUP이라 안 눌림=HIGH, 눌림=LOW.

const int BUTTON_1_PIN = 7;
const int BUTTON_2_PIN = 8;
const int LED_PIN = 11;
const int VIBRATION_PIN = 10;

const unsigned long DEBOUNCE_MS = 30;
// 0-255 PWM 듀티. 세기 조절 기능은 없음 — 웹은 오직 이 값 하나(ON)와
// 0(OFF)만 사용하며, 모터가 쓸 수 있는 세기 조절 명령 자체가 존재하지
// 않는다는 점을 웹 쪽에도 그대로 전달해 두었음.
const int VIBRATION_DUTY = 200;

struct DebouncedButton {
  int pin;
  int lastStable;    // INPUT_PULLUP 기본 상태
  int lastReading;
  unsigned long lastChangeMs;
  DebouncedButton(int p) : pin(p), lastStable(HIGH), lastReading(HIGH), lastChangeMs(0) {}
};

DebouncedButton button1(BUTTON_1_PIN);
DebouncedButton button2(BUTTON_2_PIN);

String serialBuffer;

void setup() {
  Serial.begin(9600);
  pinMode(BUTTON_1_PIN, INPUT_PULLUP);
  pinMode(BUTTON_2_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  pinMode(VIBRATION_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  analogWrite(VIBRATION_PIN, 0);
}

// 디바운스 + 하강 엣지(HIGH->LOW, 즉 "지금 막 눌림") 검출만 true를 반환.
// 눌려 있는 동안 계속 호출돼도 한 번만 true가 나온다.
bool checkPressed(DebouncedButton &btn) {
  int reading = digitalRead(btn.pin);
  if (reading != btn.lastReading) {
    btn.lastChangeMs = millis();
    btn.lastReading = reading;
  }
  bool pressedEdge = false;
  if ((millis() - btn.lastChangeMs) > DEBOUNCE_MS && reading != btn.lastStable) {
    btn.lastStable = reading;
    if (btn.lastStable == LOW) pressedEdge = true;
  }
  return pressedEdge;
}

void handleSerialLine(const String &line) {
  if (line == "VIBRATE_ON") {
    analogWrite(VIBRATION_PIN, VIBRATION_DUTY);
  } else if (line == "VIBRATE_OFF") {
    analogWrite(VIBRATION_PIN, 0);
  } else if (line == "MEASURE_ON") {
    digitalWrite(LED_PIN, HIGH);
  } else if (line == "MEASURE_OFF") {
    digitalWrite(LED_PIN, LOW);
  }
  // 그 외 줄(디버그 출력 등)은 조용히 무시 — 웹 쪽도 동일하게 무시함.
}

void loop() {
  if (checkPressed(button1)) {
    Serial.println("BUTTON_1_TIME_MEASURE");
  }
  if (checkPressed(button2)) {
    Serial.println("BUTTON_2_PLAY_RESULT");
  }

  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      serialBuffer.trim();
      if (serialBuffer.length() > 0) handleSerialLine(serialBuffer);
      serialBuffer = "";
    } else if (c != '\r') {
      serialBuffer += c;
    }
  }
}
