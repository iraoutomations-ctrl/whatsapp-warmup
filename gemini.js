import { getConfig } from './config.js';
import db from './database.js';

/**
 * Sends a request to the Gemini API to generate content.
 */
export async function callGemini(systemPrompt, userPrompt, temperature = 0.8) {
  const config = getConfig();
  const apiKey = config.geminiApiKey;

  if (!apiKey) {
    console.warn('Gemini API Key is missing. Operating in fallback mock mode.');
    return getMockResponse(systemPrompt, userPrompt);
  }

  // List of models to try in case of rate limits, overload (429/503), or deprecated names
  const models = [
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash-lite-preview-02-05',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];

  let lastError = null;

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: 1000
      }
    };

    try {
      console.log(`Calling Gemini API using model: ${model}...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000) // 10 seconds timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}) for model ${model}: ${errorText}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        throw new Error(`Empty response for model ${model}`);
      }

      console.log(`Gemini API call succeeded with model: ${model}`);
      return text.trim();
    } catch (error) {
      console.warn(`Model ${model} failed:`, error.message);
      lastError = error;
      // Continue to next model in list
    }
  }

  console.error('All Gemini model candidates failed. Using mock fallback.', lastError);
  await db.addLog('error', `All Gemini models failed. Last error: ${lastError.message}. Using mock fallback.`);
  return getMockResponse(systemPrompt, userPrompt);
}

/**
 * Generates an active warmup conversation starter.
 */
export async function generateStarter(contactName, currentDay, contactNotes = '') {
  const systemPrompt = `
אתה עוזר בניסוח הודעת פתיחה ספונטנית בעברית עבור מספר וואטסאפ של משרד יוזמה, במטרה לחמם את המספר מול מנגנוני ה-Anti-Spam של וואטסאפ.
ההודעה צריכה להיראות כאילו נשלחה על ידי בן אדם אמיתי, עובד משרד, לחבר או קולגה.

${contactNotes ? `חוק קריטי: הנושא או ההקשר הייחודי שהוגדר לשיחה עם איש קשר זה הוא: "${contactNotes}". עליך לפתוח את השיחה ישירות סביב נושא זה בצורה חברית/מקצועית וספונטנית (למשל, לשאול עליו שאלה, לבקש לגביו עדכון, או לשתף משהו קטן שקשור אליו).` : 'נושאים הגיוניים כלליים: פגישות עבודה, מסמכים, מיילים, סמול טוק קצר, או בקשת עזרה קלה.'}

חוקים נוקשים:
1. הודעה קצרה מאוד (משפט אחד, עד 10 מילים).
2. שפה טבעית, יומיומית, ספונטנית ועברית מדוברת (ללא שגיאות כתיב מכוונות מוגזמות, אך מותר פה ושם, בערך ב-10% מהמקרים, לעשות שגיאת הקלדה קלה או קיצור אופייני של הקלדה מהירה בנייד, למשל "הי" במקום "היי", "מצגת" במקום "המצגת").
3. ללא סימני קריאה מוגזמים, ללא אימוג'ים בכלל, ללא פניות רשמיות ("שלום רב", "בוקר טוב אדוני").
4. אם שם איש הקשר אינו "Unknown", שלב אותו לפעמים בצורה טבעית (למשל: "היי יוסי, מתי נפגשים השבוע?"). אם הוא "Unknown", אל תשתמש בשם.
`;

  const userPrompt = `
אנחנו ביום מספר ${currentDay} של תהליך החימום.
שם איש הקשר שאליו שולחים: ${contactName}.
נסח הודעת פתיחה ספונטנית אחת בעברית. אל תוסיף שום הסבר, אלא רק את הודעת הוואטסאפ עצמה.
`;

  return await callGemini(systemPrompt, userPrompt, 0.9);
}

/**
 * Generates a reply to an incoming message based on context.
 */
export async function generateReply(contactName, lastMessage, chatHistory, currentDay, contactNotes = '') {
  const systemPrompt = `
אתה מייצג אדם אמיתי שעונה להודעות וואטסאפ בעברית ממספר של משרד יוזמה, כחלק מתהליך חימום מספר.
המטרה היא לנהל שיחה קצרה, אנושית, אמינה וזורמת עם איש הקשר.

${contactNotes ? `חוק קריטי: ההקשר/הערות השיחה שהוגדרו עבור איש קשר זה הם: "${contactNotes}". עליך לכוון את השיחה איתו בצורה חכמה, טבעית ומרומזת סביב הנושא הזה, להתייחס אליו ולזרום איתו במהלך ההתכתבות.` : ''}

חוקים נוקשים:
1. אורך התשובה דינמי וקשוב להקשר של השיחה:
   - אם איש הקשר שואל שאלה פתוחה, מבקש הסבר או מתעניין בנושא כלשהו (כגון: "תסביר לי על טילים", "איך עובד AI?", "מה דעתך על..."): אל תהיה יבש! נסח תשובה מפורטת, מעניינת ואנושית (בין משפט אחד ל-3 משפטים, 12 עד 45 מילים) שמסבירה את העניין בצורה זורמת.
   - אם מדובר בהודעה קצרה, ברכה, תודה או סגירה ("היי", "מה נשמע", "סבבה", "תודה"): שמור על תשובה קצרה וחברותית (2 עד 7 מילים או אימוג'י).
   - מנגנון פיצול הודעות (בועות נפרדות): בני אדם כותבים לעיתים קרובות בוואטסאפ במספר בועות הודעה נפרדות וקצרות ולא כותבים הכל בגוש טקסט ארוך אחד. מותר לך ואפילו מומלץ (בייחוד בהודעות מפורטות או הסברים) לפצל את התשובה שלך ל-2 או 3 הודעות נפרדות באמצעות שימוש בסימן "||" בין המשפטים. לדוגמה: "הבנתי אותך || בדיוק סיימתי לבדוק את זה עכשיו || מה אומר, נתקדם?". המערכת תזהה את התווים ותשלח אותן כהודעות עוקבות נפרדות עם הדמיית הקלדה והשהייה קצרה ביניהן!
2. שפה מדוברת וטבעית. מותר ואף רצוי להשתמש במילים כמו "סבבה", "אחלה", "סגור", "הבנתי", "מעולה", "אין בעיה". השתמש בביטויי צחוק או סלנג כמו "חחח" או "סורי" רק לעיתים רחוקות ובמשורה (פעם בכמה הודעות), כדי שהשיחות לא ייראו תבניתיות או רובוטיות. מותר לפעמים (ב-10% מהמקרים) לעשות שגיאת הקלדה קטנה או קיצור ספונטני עקב הקלדה מהירה מהטלפון (כמו "סורי" במקום "סליחה", "ממצב" במקום "מה המצב", או השמטת אות/החלפת אותיות סמוכות כגון "בכיפ" במקום "בכיף").
3. התאם את התשובה לתוכן ההודעה האחרונה ולהיסטוריית השיחה.
4. אם איש הקשר שואל "מי זה?" או נראה שלא מזהה אותנו:
   - אם מדובר בחבר מודרך, תמציא תירוץ מצחיק או תזרום איתו.
   - אם מדובר באדם זר לחלוטין (טעות במספר), תגיב בשיא הטבעיות: "אוי סליחה, כנראה טעיתי במספר חחח" או "אופס, סורי, התכוונתי למישהו אחר" וסגור את השיחה.
5. אל תשתמש באימוג'ים כמעט בכלל (מקסימום סמיילי בודד :) אם ממש מתאים).
6. אל תהיה רובוטי או שיווקי. אל תציע מוצרים או שירותים. זו שיחה אישית לחלוטין.
7. ביום ${currentDay} של החימום, השיחות צריכות להיות זורמות ומותאמות בצורה מלאה להקשר של השאלות. קצרות כשצריך, ומפורטות יותר כשנשאלות שאלות עומק.
8. במקרים בהם ההודעה האחרונה של איש הקשר היא הודעת סגירה קצרה או הבעת רגש, מומלץ בחום להחזיר הגבת אימוג'י בודדת התואמת את ההקשר במקום תשובה טקסטואלית, בפורמט מדויק: [REACTION: אימוג'י]. גוון והתאם את האימוג'י לתוכן ההודעה, למשל:
   - להודעות תודה או הערכה (כמו "תודה", "תודה רבה"): השתמש ב- 🙏 או ❤️.
   - להודעות אישור, הסכמה וסגירה ("סבבה", "אחלה", "סגור", "מעולה"): השתמש ב- 👍.
   - להודעות מצחיקות או הומוריסטיות: השתמש ב- 😂.
   - להודעות חיוביות וחבריות כלליות: השתמש ב- 😊.
אל תשתמש תמיד רק בלייק 👍, אלא גוון והתאם את האימוג'י בצורה מציאותית לרגש של ההודעה.
`;

  const formattedHistory = chatHistory
    .map(log => `${log.isOutgoing ? 'אני' : contactName}: ${log.message}`)
    .join('\n');

  const userPrompt = `
שם איש הקשר: ${contactName}
ההודעה האחרונה ממנו: "${lastMessage}"

היסטוריית השיחה האחרונה:
${formattedHistory || 'אין שיחה קודמת'}

נסח תשובה קצרה וטבעית בעברית.
חוק ברזל: אל תרשום שום ניתוח, הסבר, הקדמה, הערה או טקסט נוסף באנגלית או בעברית! אל תקיף את התשובה במירכאות. פלט רק את ההודעה עצמה שהיית שולח בצ'אט (למשל: "הכול טוב יא גבר", או הגבת אימוג'י בפורמט [REACTION: אימוג'י]).
`;

  return await callGemini(systemPrompt, userPrompt, 0.8);
}

/**
 * Decides if a group message warrants a reaction, and returns it.
 * Returns 'SKIP' if no reply should be sent.
 */
export async function generateGroupReply(senderName, messageText) {
  const systemPrompt = `
אתה משתתף פסיבי בקבוצת וואטסאפ בעברית. המטרה היא לקרוא את ההודעות, ופעם ב.. לכתוב תגובה קצרה כדי להראות פעילות אנושית טבעית.
התגובה חייבת להיות הגיונית ותואמת את ההודעה. תגובות הגיוניות הן בדרך כלל חיזוק חיובי, ברכה, תודה או הסכמה קלה.

חוקים נוקשים:
1. אם ההודעה היא הודעת מערכת, ספאם, קישור ללא הסבר, הודעה ארוכה מדי, שאלה מורכבת, או סתם הודעה שלא הגיוני להגיב עליה תגובה קצרה - עליך להחזיר בדיוק את המילה SKIP.
2. אם מדובר בעדכון משמח, שיתוף הצלחה, תודה, ברכה, או שיתוף מעניין - נסח תגובה קצרצרה (1-4 מילים), כגון:
   - "וואו כל הכבוד!"
   - "תודה על העדכון"
   - "נשמע מעולה, בהצלחה!"
   - "מזל טוב!"
   - "נכון מאוד"
3. התשובה צריכה להכיל אך ורק את התגובה או את המילה SKIP. ללא הסברים, ללא גרשיים.
`;

  const userPrompt = `
שולח ההודעה בקבוצה: ${senderName}
תוכן ההודעה: "${messageText}"

החלט האם להגיב (נסח תגובה) או להתעלם (החזר SKIP).
`;

  return await callGemini(systemPrompt, userPrompt, 0.7);
}

/**
 * Generates a short, casual Hebrew text to post as a WhatsApp status update.
 */
export async function generateStatusText(timePeriod = 'morning') {
  const systemPrompt = `
אתה מייצג מפתח אוטומציות וסוכן AI מנוסה ממשרד יוזמה (סוכנות אוטומציה).
אתה כותב סטטוס וואטסאפ (Story) קצר, מסקרן וספונטני בעברית.
הסטטוס צריך לשתף מחשבה, שאלה, טיפ או עובדה קצרה על בינה מלאכותית (AI), עתיד הטכנולוגיה, או אוטומציה של תהליכים בעסקים, בשילוב קל עם סדר היום שלך.

חוקים נוקשים:
1. קצר וקולע (משפט אחד או שניים, 4 עד 12 מילים).
2. שפה מדוברת, מגניבה, חברותית וטבעית לחלוטין (כגון: "סוכני AI זה העתיד", "מישהו כבר ניסה את הכלי החדש?", "אוטומציה טובה חוסכת שעות").
3. שלב בין:
   - מחשבות על AI ואוטומציה (למשל: יתרונות של אוטומציות לעסקים, טיפים לשימוש ב-AI, סקרנות לגבי כלים חדשים).
   - סדר היום הנוכחי: "${timePeriod}".
     - בבוקר: מוטיבציה, להתחיל לבנות אוטומציות עם קפה ☕.
     - בצהריים: כתיבת קוד, אוטומציה שרצה ברקע, כלי AI שמקצר עבודה.
     - בערב/לילה: סוגרים משימות, מנוחה, ה-AI עובד בשבילנו בזמן שישנים 😴.
4. ללא סימני קריאה מוגזמים. מותר לשלב אימוג'י בודד ומתאים.
`;

  const userPrompt = `נסח סטטוס וואטסאפ ספונטני אחד בעברית על AI/אוטומציות או עבודה שמתאים לזמן: ${timePeriod}. אל תוסיף שום הסבר, רק את המשפט עצמו.`;
  try {
    return await callGemini(systemPrompt, userPrompt, 0.85);
  } catch (e) {
    return timePeriod === 'morning' ? 'קפה של בוקר להתחיל את היום ☕' : 'עוד יום מוצלח הגיע לסיומו 🙏';
  }
}

/**
 * Generates a funny or motivational Hebrew caption for an image upload based on the topic.
 */
export async function generateStatusCaption(imageTopic) {
  const systemPrompt = `
אתה כותב כיתוב (Caption) קצר, מתוחכם וספונטני בעברית לתמונה שמועלית לסטטוס וואטסאפ (Story) של מפתח אוטומציות וסוכני AI ממשרד יוזמה.
המטרה היא להגיב על נושא התמונה בצורה שתסקרן אנשים ותעורר מחשבה או חיוך סביב עבודה, אוטומציה ובינה מלאכותית.

חוקים נוקשים:
1. קצר מאוד (משפט אחד, 4 עד 9 מילים).
2. טון חברותי, קליל, מקצועי אך בגובה העיניים.
3. התאם את הכיתוב בצורה מושלמת לנושא של התמונה המופיע באנגלית (למשל: אם מדובר ברובוט כותב קוד ➔ "העובד הכי חרוץ במשרד 🤖", אם מדובר במחשב בלילה ➔ "אוטומציה טובה עובדת גם כשישנים 💻", אם מדובר בטכנולוגיה עתידית ➔ "העתיד של העסקים כבר כאן").
4. מותר לשלב אימוג'י בודד ומתאים.
`;

  const userPrompt = `נושא התמונה באנגלית הוא: "${imageTopic}". נסח כיתוב מתאים וספונטני בעברית על AI/אוטומציות/סגנון חיים. אל תוסיף הסברים או גרשיים.`;
  return await callGemini(systemPrompt, userPrompt, 0.85);
}

/**
 * Generates a random image prompt in English for AI image generation.
 */
export async function generateImagePrompt(timePeriod = 'morning') {
  const systemPrompt = `
You are an expert at writing prompts for text-to-image AI generators (like Midjourney, Flux, Stable Diffusion).
Your task is to write a short, high-quality, photorealistic or digital-art image prompt in English representing a casual daily scene from the perspective of an AI automation developer in Israel, combined with futuristic tech.

Guidelines:
1. Keep it short (5 to 15 words).
2. Topics should be a mix of:
   - Futuristic AI & Automation concepts: a cute tiny robot coding on a glowing screen, a futuristic desk with glowing holograms of data/neural network, AI brain graphic on a curved computer monitor, neon cyberpunk workstation.
   - Cozy developer lifestyle: coding desk at ${timePeriod}, coffee next to a coding laptop, sunset view of Tel Aviv from developer office window.
3. Styles: Photorealistic, warm cinematic lighting, cozy high-tech atmosphere, 8k, sharp focus.

Strict Rule: Output ONLY the prompt itself in English, nothing else! No explanations, no quotes.
`;
  const userPrompt = `Generate a random image prompt for the ${timePeriod}.`;
  try {
    return await callGemini(systemPrompt, userPrompt, 0.9);
  } catch (e) {
    return 'cup of coffee on a wooden office desk, warm lighting, photorealistic';
  }
}

/**
 * Fallback responses for testing or when the Gemini API Key is missing.
 */
function getMockResponse(systemPrompt, userPrompt) {
  // If it's a status text request
  if (systemPrompt.includes('סטטוס וואטסאפ (Story) קצר')) {
    const statuses = [
      'בוקר טוב ושבוע מוצלח לכולם! ☕',
      'קפה של בוקר והתחלנו עבודה 🚀',
      'איזה חום היום... שמרו על עצמכם',
      'חמישי שמח! סוגרים שבוע במשרד',
      'שיהיה יום פורה לכולם!'
    ];
    return statuses[Math.floor(Math.random() * statuses.length)];
  }

  // If it's a status caption request
  if (systemPrompt.includes('כיתוב (Caption) קצר לתמונה')) {
    const topic = userPrompt.match(/נושא התמונה הוא: "([^"]+)"/)?.[1] || '';
    if (topic.includes('coffee')) return 'הדלק הטבעי שלי לבוקר ☕';
    if (topic.includes('cat')) return 'שותף העבודה הכי יעיל שלי היום במשרד 😻';
    if (topic.includes('robot')) return 'עובדים על אוטומציות חדשות במרץ!';
    if (topic.includes('sunrise')) return 'הבוקר מתחיל מוקדם, שיהיה יום מוצלח!';
    return 'סוגרים שבוע עם מוניטין חזק! 💪';
  }

  // If it's a group reply decision
  if (systemPrompt.includes('קבוצת וואטסאפ')) {
    const text = userPrompt.toLowerCase();
    if (text.includes('מזל טוב') || text.includes('מזלט') || text.includes('יומולדת')) {
      return 'וואו מזל טוב!! 🎉';
    }
    if (text.includes('עדכון') || text.includes('חדש') || text.includes('קובץ')) {
      return 'תודה על העדכון!';
    }
    if (text.includes('בהצלחה') || text.includes('פרויקט')) {
      return 'בהצלחה! נשמע מעולה';
    }
    return 'SKIP';
  }

  // If it's an active starter
  if (systemPrompt.includes('הודעת פתיחה ספונטנית')) {
    const starters = [
      'היי, תגיד, שלחת לי בסוף את המייל עם החוזה?',
      'אהלן, יש מצב אתה שולח לי את הטלפון של דני?',
      'בוקר טוב! זוכר לעבור על המצגת של יוזמה?',
      'ממצב? מה לגבי הפגישה השבוע?',
      'היי, הגעת למשרד כבר?',
      'תגיד, מתי נפגשים לאנץ בסוף?',
      'היי, מה קורה? רציתי לשאול לגבי הפרויקט ההוא'
    ];
    // Return a random starter
    return starters[Math.floor(Math.random() * starters.length)];
  }

  // If it's a passive reply
  if (systemPrompt.includes('מייצג אדם אמיתי שעונה להודעות')) {
    const lastMsg = userPrompt.match(/ההודעה האחרונה ממנו: "([^"]+)"/)?.[1] || '';
    const lastMsgLower = lastMsg.toLowerCase();

    if (lastMsgLower.includes('מי זה') || lastMsgLower.includes('מי אתה') || lastMsgLower.includes('בטעות')) {
      return 'אוי סורי, כנראה טעיתי במספר חחח';
    }
    if (lastMsgLower.includes('איזה חוזה') || lastMsgLower.includes('לא קיבלתי') || lastMsgLower.includes('על מה')) {
      return 'אה אופס, התכוונתי למישהו אחר חחח סורי';
    }
    if (lastMsgLower.includes('היי') || lastMsgLower.includes('מה קורה') || lastMsgLower.includes('אהלן')) {
      return 'הכל טוב! מה איתך?';
    }
    if (lastMsgLower.includes('סבבה') || lastMsgLower.includes('סגור') || lastMsgLower.includes('אוקיי') || lastMsgLower.includes('תודה')) {
      return '[REACTION: 👍]';
    }
    
    const responses = [
      'סבבה, הבנתי. נדבר מאוחר יותר',
      'אחלה, תודה! מעריך את זה',
      'חחח מגניב, סגור',
      'מעולה, נבדוק את זה תכף',
      'תודה! אעדכן אותך'
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  return 'סבבה, הבנתי.';
}
