SELECT e.id, e.unit, e.make, e.model, e.model_year,
       e.vin_numberserial AS vin, e.license_plate_if_applicable AS plate, e.status,
       (SELECT l.site_namedepartment FROM locations l WHERE l.id = e.locationdepartment) AS location
FROM equipment e
WHERE e.type = '' OR e.type IS NULL
ORDER BY e.unit;
