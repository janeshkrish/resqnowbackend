export const EMAIL_TEMPLATE_DEFAULTS = Object.freeze([
  {
    eventType: "USER_REGISTER",
    subject: "Welcome to ResQNow",
    content:
      "<h2>Hi {{name}}</h2><p>Welcome to ResQNow! We're excited to have you.</p>",
  },
  {
    eventType: "TECHNICIAN_REGISTER",
    subject: "Welcome to ResQNow Technician Network",
    content:
      "<p>Hi {{name}}, your technician account has been created with ResQNow.</p>",
  },
  {
    eventType: "TECHNICIAN_APPLICATION_SUBMITTED",
    subject: "Application Received",
    content:
      "<p>Hi {{name}}, our team will review your application and contact you soon.</p>",
  },
  {
    eventType: "TECHNICIAN_APPLICATION_APPROVED",
    subject: "Application Approved",
    content:
      "<p>Congrats {{name}}, your application is approved!</p>",
  },
  {
    eventType: "TECHNICIAN_APPLICATION_REJECTED",
    subject: "Application Update",
    content:
      "<p>Hi {{name}}, your application has been rejected.</p>",
  },
  {
    eventType: "ADMIN_NEW_TECHNICIAN_APPLICATION",
    subject: "New Technician Application",
    content:
      "<p>{{name}} submitted a technician application.</p><p>Email: {{applicantEmail}}</p>",
  },
  {
    eventType: "ADMIN_NEW_USER_REQUEST",
    subject: "New User Request",
    content:
      "<p>A new service request was created.</p><p>Request ID: {{requestId}}</p><p>Service: {{serviceType}}</p><p>User: {{name}}</p>",
  },
  {
    eventType: "ADMIN_TECHNICIAN_ASSIGNED",
    subject: "Technician Assigned",
    content:
      "<p>A technician has been assigned to a user request.</p><p>Request ID: {{requestId}}</p><p>Technician: {{technicianName}}</p><p>User: {{name}}</p>",
  },
]);

export const EMAIL_TEMPLATE_EVENT_TYPES = Object.freeze(
  EMAIL_TEMPLATE_DEFAULTS.map((template) => template.eventType)
);
