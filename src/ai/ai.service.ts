import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

export const smartElecSystemPrompt = `Bạn là "SmartElec Buddy" - Chuyên gia kỹ thuật điện nước dạn dày kinh nghiệm, cực kỳ thân thiện và tâm lý.
Nhiệm vụ: Lắng nghe, chẩn đoán sự cố, đánh giá rủi ro và tư vấn an toàn.

══════════════════════════════════════════
QUY TẮC DỮ LIỆU & CHỐNG ẢO GIÁC
══════════════════════════════════════════
- Chỉ được sử dụng thông tin thiết bị có trong [THÔNG TIN NỘI BỘ] của khách hàng.
- Nếu khách hàng nói về một thiết bị KHÔNG có trong danh sách nội bộ: Hãy hỏi xác nhận đó có phải thiết bị mới không trước khi tiến hành chẩn đoán.
- Nếu có hình ảnh đính kèm: Hãy phân tích hình ảnh để tìm các dấu hiệu nguy hiểm (khói, tia lửa, rò rỉ, cháy xém) và cập nhật ngay vào phần "flags".

══════════════════════════════════════════
GIAI ĐOẠN 2 — CHẨN ĐOÁN (phase=DIAGNOSING)
══════════════════════════════════════════
--- 2A. PHÂN LOẠI RỦI RO ---
🔴 MỨC ĐỎ: mùi khét, khói, tia lửa, rò điện, aptomat nhảy liên tục.
🟡 MỨC VÀNG: Lỗi nguồn không ổn định, đèn báo lỗi, chập chờn, tự tắt/khởi động lại.
🟢 MỨC XANH: Lỗi vận hành thuần túy (không lạnh, không vắt đồ, ồn).

--- 2B. FORMAT OUTPUT ---
Lời phản hồi cho khách phải chuyên nghiệp, dùng Markdown để làm nổi bật từ khóa quan trọng.
Cấu trúc câu trả lời: Tóm tắt -> Nguyên nhân -> Hướng dẫn an toàn -> Kết luận.

══════════════════════════════════════════
QUY TẮC ĐẶT THỢ (BẮT BUỘC)
══════════════════════════════════════════
- Nếu khách hàng muốn gọi thợ hoặc đồng ý đặt lịch: BẮT BUỘC kích hoạt trigger_booking tool.

══════════════════════════════════════════
BẮT BUỘC TRẢ VỀ JSON THEO ĐỊNH DẠNG SAU:
══════════════════════════════════════════
{
  "text": "Câu trả lời của bạn cho khách hàng",
  "state": {
    "phase": "COLLECTING" | "DIAGNOSING" | "READY_TO_BOOK",
    "risk": "RED" | "YELLOW" | "GREEN" | "UNKNOWN",
    "device": "Tên thiết bị",
    "symptom": "Mô tả triệu chứng",
    "flags": ["tag1", "tag2"]
  }
}
`;

@Injectable()
export class AiService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private readonly logger = new Logger(AiService.name);
  
  // CHỐT CHẶN 1: MAP LƯU TRỮ THỜI GIAN GỬI REQUEST GẦN NHẤT
  private lastRequestTime = new Map<number, number>();

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY') || '';
    this.genAI = new GoogleGenerativeAI(apiKey);
    
    const responseSchema: any = {
      type: SchemaType.OBJECT,
      properties: {
        text: { type: SchemaType.STRING, description: "Lời phản hồi cho khách hàng" },
        state: {
          type: SchemaType.OBJECT,
          properties: {
            device: { type: SchemaType.STRING },
            symptom: { type: SchemaType.STRING },
            ctx: { type: SchemaType.STRING },
            phase: { type: SchemaType.STRING, enum: ["COLLECTING", "DIAGNOSING", "READY_TO_BOOK"] },
            risk: { type: SchemaType.STRING, enum: ["GREEN", "YELLOW", "RED", "UNKNOWN"] },
            flags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } }
          },
          required: ["phase", "risk"]
        },
        is_booking_triggered: { type: SchemaType.BOOLEAN }
      },
      required: ["text", "state"]
    };

    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash', 
      systemInstruction: smartElecSystemPrompt,
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        topK: 40,
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'trigger_booking',
              description: 'Gọi khi khách muốn đặt thợ.',
              parameters: {
                type: SchemaType.OBJECT,
                properties: {
                  device: { type: SchemaType.STRING },
                  symptom: { type: SchemaType.STRING }
                },
                required: ['device', 'symptom'],
              } as any,
            },
          ],
        },
      ],
    });
  }

  async chatWithAI(userId: number, message: string, imageBase64?: string, history: any[] = []) {
    // 1. KIỂM TRA RATE LIMIT (CHỐNG SPAM/VÒNG LẶP)
    const now = Date.now();
    const lastTime = this.lastRequestTime.get(userId) || 0;
    if (now - lastTime < 2000) {
      throw new HttpException('Bạn đang thao tác quá nhanh, vui lòng đợi giây lát!', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.lastRequestTime.set(userId, now);

    let sessionId: number | null = null;
    let parsed: any = null;
    
    try {
      // 2. LẤY TRẠNG THÁI CŨ TỪ DATABASE ĐỂ MERGE
      const lastLog = await this.prisma.aiReasoningLog.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' }
      });
      const prevState = lastLog?.nextState || null;
      const lastStateContext = prevState ? `\n[TRẠNG THÁI HIỆN TẠI]: ${JSON.stringify(prevState)}` : '';

      const devices = await this.prisma.device.findMany({
        where: { userId },
        select: { category: true, brandName: true, modelCode: true },
      });

      let deviceContext = '';
      if (devices.length > 0) {
        deviceContext = `\n[THÔNG TIN NỘI BỘ]: Khách hàng có: ${devices.map(d => d.category).join(', ')}`;
      }

      // 🧠 RLHF: Lấy feedback từ DB để "dạy" AI trước khi gọi
      const [likedLogs, dislikedLogs] = await Promise.all([
        this.prisma.aiReasoningLog.findMany({
          where: { userId, aiFeedback: 'LIKE', aiResponse: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 2,
          select: { aiResponse: true },
        }),
        this.prisma.aiReasoningLog.findMany({
          where: { userId, aiFeedback: 'DISLIKE', aiResponse: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { aiResponse: true },
        }),
      ]);

      let rlhfInstruction = '';
      if (likedLogs.length > 0 || dislikedLogs.length > 0) {
        const likedText = likedLogs.map((l, i) => `  [Câu trả lời được thích #${i+1}]: "${(l.aiResponse ?? '').substring(0, 300)}..."`).join('\n');
        const dislikedText = dislikedLogs.map((l, i) => `  [Câu trả lời bị chê #${i+1}]: "${(l.aiResponse ?? '').substring(0, 300)}..."`).join('\n');
        rlhfInstruction = `
[LỊCH SỬ PHẢN HỒI CỦA NGƯỜI DÙNG ĐỂ BẠN HỌC HỎI]:
- Những câu trả lời khách hàng đã RẤT THÍCH (Hãy học theo cách tư duy, giọng điệu và độ chi tiết này):
${likedText || '  (Chưa có)'}
- Những câu trả lời khách hàng KHÔNG THÍCH (Tuyệt đối KHÔNG lặp lại lỗi, cách nói dài dòng hoặc sai kiến thức như thế này):
${dislikedText || '  (Chưa có)'}
[HẾT LỊCH SỬ PHẢN HỒI]
`;
        this.logger.log(`🧠 [RLHF] Injected ${likedLogs.length} LIKE + ${dislikedLogs.length} DISLIKE vào prompt cho user #${userId}`);
      }

      const promptWithRLHF = `${rlhfInstruction}${deviceContext}${lastStateContext}\n\nKhách nhắn: ${message}`;
      const parts: any[] = [{ text: promptWithRLHF }];
      if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });

      const chat = this.model.startChat({
        history: history.map((h) => ({
          role: (h.role === 'assistant' || h.role === 'model') ? 'model' : 'user',
          parts: [{ text: h.content }],
        })),
      });

      const result = await chat.sendMessage(parts);
      const response = result.response;
      
      const calls = response.functionCalls();
      if (calls && calls.length > 0) {
        const bookingCall = calls.find(c => c.name === 'trigger_booking');
        if (bookingCall) {
          const args = bookingCall.args as any;
          sessionId = await this.saveRepairCase(userId, args.device, args.symptom, "Booking via tool");
          return {
            text: `Dạ em đã ghi nhận yêu cầu đặt thợ cho **${args.device}**. Anh/chị có muốn em đẩy đơn ngay không ạ?`,
            state: { phase: "READY_TO_BOOK", device: args.device, symptom: args.symptom, risk: "YELLOW" },
            sessionId
          };
        }
      }

      const rawText = response.text();
      try {
        // CHỐT CHẶN 2: DÙNG REGEX ĐỂ TRÍCH XUẤT JSON NẾU AI TRẢ VỀ MARKDOWN
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const jsonToParse = jsonMatch ? jsonMatch[0] : rawText;
        parsed = JSON.parse(jsonToParse);
      } catch (e) {
        this.logger.warn("Failed to parse AI JSON, falling back to raw text");
        parsed = {
          text: rawText.replace(/```json|```/g, '').substring(0, 500),
          state: prevState || { phase: "COLLECTING", risk: "UNKNOWN", device: null, symptom: null },
          is_booking_triggered: false
        };
      }

      // 3. ĐỒNG BỘ DANGER KEYWORDS (VIỆT HÓA)
      const dangerKeywords = [
        'smoke', 'spark', 'fire', 'electric_leak', 'shocks', 
        'khói', 'lửa', 'tia lửa', 'cháy', 'khét', 'nổ', 'giật', 
        'rò điện', 'tóe lửa', 'chập điện', 'bốc khói'
      ];
      const hasDangerFlag = parsed.state?.flags?.some((f: string) => dangerKeywords.includes(f.toLowerCase()));
      
      if (parsed.state?.risk === 'RED' || hasDangerFlag) {
        parsed.text = `⚠️ **CẢNH BÁO KHẨN CẤP: Vui lòng đứng tránh xa và ngắt ngay cầu dao tổng trước khi tiếp tục!**\n\n${parsed.text}`;
      }

      if (parsed.state?.device && parsed.state.symptom) {
        sessionId = await this.saveRepairCase(userId, parsed.state.device, parsed.state.symptom, parsed.text);
      }

      // 4. LƯU LOG VỚI STATE THẬT và lấy logId để trả về Flutter
      let logId: number | null = null;
      try {
        logId = await this.saveReasoningLog(userId, sessionId, message, prevState, parsed);
      } catch (e) {
        this.logger.error("Failed to save reasoning log", e);
      }

      return { ...parsed, sessionId, logId };
    } catch (error: any) {
      this.logger.error(`AI Error: ${error.message}`);
      
      // Xử lý lỗi Rate Limit (429) từ phía Google
      if (error.message?.includes('429')) {
        return { 
          text: "Dạ hiện tại lượt dùng thử Gemini 2.5 đang hết, anh đợi em xíu hoặc thử lại sau nha!", 
          state: null 
        };
      }
      
      // Chuyển tiếp lỗi Rate Limit (429) nội bộ
      if (error instanceof HttpException) throw error;
      
      return { text: "Dạ hệ thống AI đang bận, bác thử lại sau xíu nha!", state: null };
    }
  }

  private async saveReasoningLog(userId: number, sessionId: number | null, userMsg: string, prevState: any, parsed: any): Promise<number | null> {
    try {
      const log = await this.prisma.aiReasoningLog.create({
        data: {
          userId,
          sessionId,
          userMsg,
          prevState: prevState || null,
          nextState: parsed?.state || null,
          riskLevel: parsed?.state?.risk || 'UNKNOWN',
          aiResponse: parsed?.text || ''
        }
      });
      return log.id; // Trả về logId cho RLHF
    } catch (err) {
      this.logger.error("Error saving reasoning log to DB", err);
      return null;
    }
  }

  private async saveRepairCase(userId: number, deviceType: string, symptom: string, summary: string): Promise<number | null> {
    try {
      const recentCase = await this.prisma.chatSession.findFirst({
        where: { userId, deviceType, symptom, createdAt: { gte: new Date(Date.now() - 1000 * 60 * 30) } },
      });
      if (recentCase) return recentCase.id;
      const newCase = await this.prisma.chatSession.create({
        data: { userId, deviceType, symptom, aiSummary: summary, status: 'AI_CONSULTING' },
      });
      return newCase.id;
    } catch (error: any) { return null; }
  }

  // ─────────────────────────────────────────────────────────────────
  // RLHF: Lưu phản hồi Like/Dislike vào AiReasoningLog
  // ─────────────────────────────────────────────────────────────────
  async saveFeedback(logId: number, feedback: 'LIKE' | 'DISLIKE') {
    const log = await this.prisma.aiReasoningLog.findUnique({ where: { id: logId } });
    if (!log) {
      throw new Error(`Không tìm thấy AI log với ID = ${logId}`);
    }
    await this.prisma.aiReasoningLog.update({
      where: { id: logId },
      data: { aiFeedback: feedback },
    });
    this.logger.log(`👍 [RLHF] User #${log.userId} đã ${feedback} log #${logId}`);
    return { success: true, feedback };
  }
}
