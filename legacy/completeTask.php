<?php
session_start();
include "connection.php";

$modalTitle = "";
$modalMessage = "";
$modalClass = "";

if (isset($_GET["id"])) {
    $id = $_GET["id"];

    if (!empty($id) && is_numeric($id)) {
        $updateQuery = "UPDATE truckloadinformationtable SET status = 'complete' WHERE id = ?";
        $updateStmt = mysqli_prepare($con, $updateQuery);

        mysqli_stmt_bind_param($updateStmt, 'i', $id);

        mysqli_stmt_execute($updateStmt);

        if (mysqli_stmt_affected_rows($updateStmt) > 0) {
            $modalTitle = "Success!";
            $modalMessage = "Task marked as complete!";
            $modalClass = "success";

        } else {

            $modalTitle = "Error!";
            $modalMessage = "Invalid task ID!";
            $modalClass = "error";
        }
    } else {
        $modalTitle = "Error!";
        $modalMessage = "Invalid task ID!";
        $modalClass = "error";

    }
    mysqli_close($con); 
} else {

    $modalTitle = "Error!";
    $modalMessage = "Invalid request!";
    $modalClass = "error";
    
}
?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Task Completion</title>
    <link rel="stylesheet" href="styles.css">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/css/bootstrap.min.css" rel="stylesheet" crossorigin="anonymous">
   
</head>
<body>



<div class="modal fade" id="successModal" tabindex="-1" aria-labelledby="successModalLabel" aria-hidden="true">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title" id="successModalLabel">Success</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label='Close' onclick="window.location.href='userIndex.php'"></button>
            </div>
            <div class="modal-body">
                The Form Was Updated Successfully
            </div>
        </div>
    </div>
</div>

<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.0.2/dist/js/bootstrap.bundle.min.js"></script>

<script>
    $(document).ready(function() {
        $('#successModal').modal('show');
    });
</script>

</body>
</html>
