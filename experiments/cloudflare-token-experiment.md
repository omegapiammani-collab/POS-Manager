# การทดลองตรวจลายเซ็น Cloudflare Access แบบออฟไลน์

การทดลองนี้ใช้ PyJWT และ cryptography ตรวจ JWT ที่เซ็นด้วยกุญแจ RSA **จำลอง** และเชื่อมผลเข้ากับ backend **จำลอง** ไม่ import จาก POS server และไม่มีบัญชี การล็อกอิน การรับ header จาก Cloudflare การดึง JWKS จากเครือข่าย หรือการ deploy จึงยังไม่ใช่ remote access ที่ใช้งานจริง

สร้าง `AccessTokenVerifier` ด้วย issuer, audience, subject เจ้าของ และ JWKS snapshot ที่จัดเตรียมภายในเทสต์เท่านั้น verifier จำกัด issuer ให้อยู่ในรูป HTTPS ของ `cloudflareaccess.com`, จำกัด algorithm เป็น RS256, เลือกกุญแจตาม kid, ตรวจลายเซ็น issuer audience subject expiry และ not-before และปฏิเสธกุญแจซ้ำ กุญแจที่ไม่รู้จัก หรือข้อมูลกำหนดค่าที่ไม่ถูกต้อง หากเปลี่ยนกุญแจต้องสร้าง verifier ใหม่จาก snapshot ใหม่ การทดลองไม่ทำ HTTP request และไม่มี URL สำหรับดึงกุญแจ จึงไม่ได้ทดลองการดึง JWKS หรือการป้องกัน SSRF ของตัวดึงข้อมูลจริง

รันแยกด้วย Python 3.12 ในสภาพแวดล้อมทดสอบที่ติดตั้ง `experiments/requirements-auth-test.txt` แล้ว:

```sh
python -m unittest experiments.test_cloudflare_token_experiment -v
```

เทสต์สร้างกุญแจใหม่ชั่วคราวในหน่วยความจำและทดสอบ token ถูกต้อง ปลอม หมดอายุ ยังไม่เริ่มใช้ issuer/audience/subject ผิด algorithm ผิด และช่วงเปลี่ยนกุญแจ ไม่มีข้อมูลร้านหรือบัญชีจริง CI มี job แยกสำหรับ dependency ทดลอง; POS เดิมยังไม่มี dependency เหล่านี้

ก่อนนำแนวทางนี้เข้าสู่ระบบจริงยังต้องเลือกและอนุมัติ provider ออกแบบการรับ token จาก `Cf-Access-Jwt-Assertion` โดยป้องกันการข้าม proxy, HTTPS และ CORS/CSRF, สร้างตัวโหลด JWKS จาก endpoint ที่กำหนดไว้ล่วงหน้าเท่านั้นพร้อม TLS validation, จำกัด timeout/cache/ขนาด response และ redirect, ทดสอบการหมุนและการถอนกุญแจ/สิทธิ์ในสภาวะเครือข่ายล้มเหลว รวมถึงตรวจว่า claims ที่ต้องการมีจริงใน integration ของบัญชีเป้าหมาย นอกจากนี้ต้องออกแบบ session, การกู้บัญชีและเพิกถอนอุปกรณ์ และทดสอบทุก endpoint กับบริการทดสอบจริงก่อนตัดสินใจ deploy ไม่สามารถรับประกันค่าใช้จ่าย 0 บาทต่อเนื่องจากผลทดลองนี้

อ้างอิง: [Cloudflare Access: Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) และ [PyJWT API](https://pyjwt.readthedocs.io/en/latest/api.html)
