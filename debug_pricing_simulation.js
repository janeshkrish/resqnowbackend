
const service_type = "car-towing";
const vehicle_type = "Other Cars - Mahindra XUV 300";
const techRow = {
    base_price: 500,
    pricing: "{}",
    service_costs: JSON.stringify([
        {
            "base_charge": "200",
            "free_distance": "100",
            "night_charge": "200",
            "per_km_charge": "100",
            "service_name": "Towing Assistance",
            "vehicle_type_pricing": "4w"
        }
    ])
};

function testPricing() {
    let computedPrice = null;

    try {
        const pricing = techRow.pricing ? JSON.parse(techRow.pricing) : null;
        const serviceCosts = techRow.service_costs ? JSON.parse(techRow.service_costs) : null;

        // Normalize service key: remove vehicle prefixes
        let svcKey = (service_type || '').toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
        svcKey = svcKey.replace(/^(car|bike|commercial)_/, '');

        console.log(`Normalized Service Key: ${svcKey}`);

        if (computedPrice == null && serviceCosts) {
            if (Array.isArray(serviceCosts)) {
                for (const sc of serviceCosts) {
                    const rawKey = sc.service_key || sc.service || sc.service_name || '';
                    const key = rawKey.toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");

                    console.log(`[PRICING CHECK] Key: ${key} vs SvcKey: ${svcKey}`);

                    if (key && (key === svcKey || key.includes(svcKey) || (svcKey && svcKey.includes(key)))) {
                        console.log("Match found!");

                        // check for vehicle-specific
                        if (vehicle_type && sc.vehicle_prices) {
                            console.log("Checking vehicle prices...");
                            const vp = sc.vehicle_prices[vehicle_type] || sc.vehicle_prices[vehicle_type.toLowerCase().replace(/\s+/g, "_")];
                            if (vp && (vp.baseCharge || vp.price || vp.amount)) {
                                computedPrice = vp.baseCharge || vp.price || vp.amount;
                                break;
                            }
                        }
                        if (sc.price || sc.baseCharge || sc.base_charge || sc.amount) {
                            console.log(`Found price in root: ${sc.price || sc.baseCharge || sc.base_charge || sc.amount}`);
                            computedPrice = sc.price || sc.baseCharge || sc.base_charge || sc.amount;
                            break;
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error:', e);
    }

    console.log(`Final Result: ${computedPrice ?? techRow.base_price ?? 500.00}`);
}

testPricing();
