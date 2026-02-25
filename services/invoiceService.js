import PDFDocument from "pdfkit";

/**
 * Generates a professional PDF invoice for a service request as an in-memory buffer.
 * @param {Object} data - Invoice data
 * @returns {Promise<Buffer>} - Generated PDF bytes
 */
export async function generateInvoicePDF(data) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: "A4", margin: 50 });
            const chunks = [];

            doc.on("data", (chunk) => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", reject);

            // --- Header Section ---
            doc.fontSize(24).font("Helvetica-Bold").fillColor("#EAB308").text("ResQNow", 50, 45);
            doc.fontSize(10).font("Helvetica").fillColor("#64748B").text("Roadside Assistance Services", 50, 75);

            doc.fontSize(16).font("Helvetica-Bold").fillColor("#0F172A").text("TAX INVOICE", 400, 45, { align: "right" });
            doc.fontSize(10).font("Helvetica").fillColor("#64748B").text(`Invoice #: ${data.invoiceId}`, 400, 70, { align: "right" });
            doc.text(`Date: ${new Date().toLocaleDateString()}`, 400, 85, { align: "right" });

            doc.moveDown(2);

            // --- Address Section (Bill To / Bill From) ---
            const customerY = 130;

            doc.fontSize(10).font("Helvetica-Bold").fillColor("#0F172A").text("Billed From:", 50, customerY);
            doc.font("Helvetica").fillColor("#64748B")
                .text("ResQNow Services Pvt Ltd.", 50, customerY + 15)
                .text("123, Tech Park, Sector 5", 50, customerY + 30)
                .text("Bangalore, KA 560103", 50, customerY + 45)
                .text("GSTIN: 29ABCDE1234F1Z5", 50, customerY + 60);

            doc.fontSize(10).font("Helvetica-Bold").fillColor("#0F172A").text("Billed To:", 300, customerY);
            doc.font("Helvetica").fillColor("#64748B")
                .text(data.customerName || "Valued Customer", 300, customerY + 15)
                .text(`Phone: ${data.customerPhone || "N/A"}`, 300, customerY + 30)
                .text(data.customerAddress ? `${data.customerAddress.substring(0, 40)}...` : "N/A", 300, customerY + 45);

            doc.moveDown(4);

            // --- Service Details Table ---
            const tableTop = 250;
            const itemX = 50;
            const descX = 150;
            const amountX = 450;

            doc.rect(50, tableTop, 500, 25).fill("#F1F5F9");
            doc.fillColor("#0F172A").font("Helvetica-Bold").fontSize(10);
            doc.text("Item", itemX + 5, tableTop + 8);
            doc.text("Description", descX, tableTop + 8);
            doc.text("Amount (INR)", amountX, tableTop + 8, { align: "right", width: 90 });

            doc.font("Helvetica").fontSize(10).fillColor("#334155");
            const rowY = tableTop + 35;

            doc.text("Service", itemX + 5, rowY);
            doc.text(`${data.serviceType} - ${data.vehicleType || "Vehicle"}`, descX, rowY);
            doc.text(Number(data.amount || 0).toFixed(2), amountX, rowY, { align: "right", width: 90 });

            const rowY2 = rowY + 20;
            doc.text("Fee", itemX + 5, rowY2);
            doc.text("Platform & Convenience Fee", descX, rowY2);
            doc.text(Number(data.platformFee || 0).toFixed(2), amountX, rowY2, { align: "right", width: 90 });

            doc.moveTo(50, rowY2 + 25).lineTo(550, rowY2 + 25).strokeColor("#E2E8F0").stroke();

            const totalY = rowY2 + 35;
            doc.fontSize(12).font("Helvetica-Bold").fillColor("#0F172A");
            doc.text("Total Amount", 350, totalY);
            doc.text(`INR ${Number(data.totalAmount || 0).toFixed(2)}`, amountX, totalY, { align: "right", width: 90 });

            doc.moveDown(4);

            const footerY = 700;
            doc.fontSize(10).font("Helvetica-Bold").fillColor("#0F172A")
                .text("Thank you for choosing ResQNow!", 50, footerY, { align: "center", width: 500 });

            doc.fontSize(8).font("Helvetica").fillColor("#94A3B8")
                .text("This is a computer generated invoice and does not require a physical signature.", 50, footerY + 15, { align: "center", width: 500 });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}