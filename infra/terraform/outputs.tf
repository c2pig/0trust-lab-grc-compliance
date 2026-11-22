output "pages_project_name" {
  description = "Cloudflare Pages project name."
  value       = module.grc_compliance_lab.pages_project_name
}

output "pages_subdomain" {
  description = "Default Cloudflare Pages subdomain."
  value       = module.grc_compliance_lab.pages_subdomain
}

output "lab_url" {
  description = "Production standalone lab URL."
  value       = module.grc_compliance_lab.lab_url
}
