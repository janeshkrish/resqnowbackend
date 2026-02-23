import {
    DEFAULT_PLATFORM_PRICING_CONFIG,
    getPlatformPricingConfig,
    getServiceMatrixAmount,
    listSubscriptionPlans,
} from "./platformPricing.js";

const sessions = new Map();

const formatAmount = (currency, amount) => {
    const numeric = Number(amount);
    const safe = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
    return `${String(currency || "INR").toUpperCase()} ${Math.round(safe)}`;
};

async function resolvePricingConfig() {
    try {
        return await getPlatformPricingConfig();
    } catch {
        return DEFAULT_PLATFORM_PRICING_CONFIG;
    }
}

class ChatbotService {
    /**
     * Process an incoming message and return a response.
     * @param {string} sessionId - Unique session ID for the user.
     * @param {string} text - The user's message.
     * @returns {Promise<object>} - { text: string }
     */
    async processMessage(sessionId, text) {
        if (!text) return { text: "I didn't catch that. Could you please repeat?" };

        const lower = text.toLowerCase();
        const context = sessions.get(sessionId) || {};
        const pricingConfig = await resolvePricingConfig();
        const currency = pricingConfig.currency || "INR";

        const bikeFlat = getServiceMatrixAmount("flat-tire", "bike", pricingConfig);
        const carFlat = getServiceMatrixAmount("flat-tire", "car", pricingConfig);
        const towingBase = getServiceMatrixAmount("towing", "car", pricingConfig);
        const batteryBase = getServiceMatrixAmount("battery", "car", pricingConfig);

        // 1. Check for Contextual Follow-ups
        if (context.awaiting === "service_type") {
            if (lower.includes("car")) {
                sessions.set(sessionId, { ...context, awaiting: null });
                return { text: "Got it! For car assistance, you can select 'Car Service' from the main menu. We offer towing, tire change, and jump starts. Do you need help booking?" };
            }
            if (lower.includes("bike") || lower.includes("motorcycle")) {
                sessions.set(sessionId, { ...context, awaiting: null });
                return { text: "Understood. For bike assistance, choose 'Bike Service' on the home page. We can help with punctures or fuel. Would you like to know the rates?" };
            }
        }

        // 2. Intent Recognition

        // GREETINGS
        if (lower.match(/\b(hi|hello|hey|greetings|start|yo)\b/)) {
            sessions.set(sessionId, { ...context, awaiting: null });
            return { text: "Hello! Welcome to ResQNow. I'm your roadside assistant. How can I help you? You can ask about services, pricing, subscriptions, or track a request." };
        }

        // SERVICES (General)
        if (lower.includes("service") || lower.includes("offer") || lower.includes("provide")) {
            return { text: "We offer 24/7 roadside assistance including: \n1. Car Towing & Repair\n2. Bike Puncture & Fuel\n3. EV Charging\n4. Commercial Vehicle Support\n\nWhich vehicle do you need help with?" };
        }

        // SPECIFIC SERVICES
        if (lower.includes("puncture") || lower.includes("tire") || lower.includes("flat")) {
            return {
                text: `We can fix flat tires. Current base pricing starts around ${formatAmount(currency, bikeFlat)} for bikes and ${formatAmount(currency, carFlat)} for cars. Would you like to book a technician?`
            };
        }
        if (lower.includes("tow") || lower.includes("breakdown")) {
            return {
                text: `Towing currently starts around ${formatAmount(currency, towingBase)} for local support. Long-distance towing is charged per km. Use the 'Car Service' option to book immediate towing.`
            };
        }
        if (lower.includes("battery") || lower.includes("jump")) {
            return {
                text: `Dead battery? Jump-start support currently starts around ${formatAmount(currency, batteryBase)}. A technician can usually reach you in 20-30 minutes.`
            };
        }

        // PRICING
        if (lower.includes("price") || lower.includes("cost") || lower.includes("fee") || lower.includes("charge")) {
            const platformFeePercent = Math.round(Number(pricingConfig.platform_fee_percent || 0) * 100);
            return {
                text: `Our pricing is transparent:\n- Base Fee: Varies by service (from about ${formatAmount(currency, pricingConfig.default_service_amount)})\n- Platform Fee: ${platformFeePercent}% per request\n- No hidden commissions.\n\nSubscribers can reduce or eliminate platform fees depending on plan.`
            };
        }

        // AVAILABILITY
        if (lower.includes("available") || lower.includes("where") || lower.includes("location") || lower.includes("city") || lower.includes("area")) {
            return { text: "We are active in major cities including Coimbatore, Chennai, and Bangalore. You can check exact technician availability by allowing location access on the home page." };
        }

        // TRACKING
        if (lower.includes("track") || lower.includes("status") || lower.includes("where is")) {
            return { text: "You can track your technician live on the 'Track Request' page. You'll need your active Request ID. Do you have a request currently in progress?" };
        }

        // SUBSCRIPTIONS
        if (lower.includes("subscription") || lower.includes("plan") || lower.includes("membership") || lower.includes("pay-as-you-go")) {
            const plans = listSubscriptionPlans(pricingConfig)
                .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0))
                .slice(0, 3);

            if (plans.length === 0) {
                return { text: "Subscription plans are currently unavailable. Please check the Subscription page shortly." };
            }

            const planLines = plans.map((plan, index) => {
                const planAmount = Number(plan.amount || 0);
                const priceLabel = planAmount <= 0
                    ? `${formatAmount(currency, 0)}`
                    : `${formatAmount(currency, planAmount)}/${plan.period || "month"}`;
                return `${index + 1}. ${plan.name}: ${priceLabel}`;
            });

            return { text: `Current plans:\n${planLines.join("\n")}\n\nCheck the Subscription page for latest benefits.` };
        }

        // TERMS
        if (lower.includes("terms") || lower.includes("policy") || lower.includes("refund")) {
            return { text: "Our services are subject to fair usage. Refunds are processed within 5-7 days if a request is cancelled before the technician arrives. See 'Terms of Service' for more." };
        }

        // IDENTITY
        if (lower.includes("who are you") || lower.includes("bot") || lower.includes("human")) {
            return { text: "I am the ResQNow virtual assistant. I'm here to answer your questions instantly. If you need a human, call our helpline at 1800-123-HELP." };
        }

        // FALLBACK / UNKNOWN
        sessions.set(sessionId, { ...context, awaiting: null });
        return { text: "I'm not sure I understood that regarding ResQNow services. You can ask about 'towing', 'pricing', 'plans', or 'tracking'. How can I assist?" };
    }
}

export const chatbotService = new ChatbotService();
